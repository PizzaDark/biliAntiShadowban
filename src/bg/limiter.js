

/**
 * limiter.js —— 请求调度器
 * 设计目标：
 *  1) 每个用户浏览器独立运行，请求量必须低于「人类正常浏览」的强度，避免触发风控；
 *  2) 同一用户多标签页共用同一个后台队列，不会并发放大；
 *  3) 全局串行 + 速率额度(令牌桶) + 随机抖动 + 指数退避 + 熔断。
 *
 * 说明：这里的「额度」是纯本地的请求节流计数，随时间自动恢复，永久免费、无总量上限，
 *      仅用于把请求强度压到正常人工浏览水平以下，不是任何形式的付费配额。
 *
 * 注意：本扩展不做任何分布式代理池、不共享 Cookie、不做多账号轮换。
 * 每个安装实例只使用「当前登录用户自己的会话」访问自己有权访问的数据。
 */

const CONFIG = {
  capacity: 5,            // 桶容量（突发上限）
  refillPerMin: 12,       // 每分钟补充令牌数 ≈ 5s 一次请求
  minIntervalMs: 1800,    // 任意两次请求最小间隔
  jitterMs: 1200,         // 随机抖动，避免规律化指纹
  maxRetry: 3,
  breakerThreshold: 3,    // 连续风控响应次数达到即熔断
  breakerCooldownMs: 10 * 60 * 1000,
};

class TokenBucket {
  constructor() {
    this.tokens = CONFIG.capacity;
    this.last = Date.now();
  }
  take() {
    const now = Date.now();
    const refill = ((now - this.last) / 60000) * CONFIG.refillPerMin;
    this.tokens = Math.min(CONFIG.capacity, this.tokens + refill);
    this.last = now;
    if (this.tokens >= 1) { this.tokens -= 1; return 0; }
    const need = (1 - this.tokens) / CONFIG.refillPerMin * 60000;
    return Math.ceil(need);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.floor(Math.random() * CONFIG.jitterMs);

export class Scheduler {
  constructor() {
    this.bucket = new TokenBucket();
    this.queue = [];
    this.running = false;
    this.lastRequestAt = 0;
    this.consecutiveBlocks = 0;
    this.breakerUntil = 0;
  }

  get state() {
    // 读取当前额度（会随时间自动恢复，这里先按时间补算一次再上报）
    const now = Date.now();
    const refilled = Math.min(
      CONFIG.capacity,
      this.bucket.tokens + ((now - this.bucket.last) / 60000) * CONFIG.refillPerMin
    );
    return {
      queued: this.queue.length,
      quota: Math.floor(refilled),          // 当前可用次数
      quotaMax: CONFIG.capacity,            // 上限
      refillPerMin: CONFIG.refillPerMin,    // 每分钟恢复多少次
      secondsPerRefill: Math.round(60 / CONFIG.refillPerMin),
      breaker: this.breakerUntil > Date.now(),
      breakerUntil: this.breakerUntil,
      // 兼容旧字段
      tokens: Math.floor(refilled),
    };
  }

  /** 入队；priority 越小越先执行 */
  schedule(taskFn, { priority = 5, key = null } = {}) {
    // 相同 key 的请求合并，避免多个标签页重复探测同一条评论
    if (key) {
      const exist = this.queue.find((t) => t.key === key);
      if (exist) return exist.promise;
    }
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.queue.push({ taskFn, priority, key, resolve, reject, promise });
    this.queue.sort((a, b) => a.priority - b.priority);
    this._pump();
    return promise;
  }

  async _pump() {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      if (Date.now() < this.breakerUntil) {
        const err = new Error('RATE_BREAKER');
        this.queue.splice(0).forEach((t) => t.reject(err));
        break;
      }
      const task = this.queue.shift();
      try {
        const wait = this.bucket.take();
        if (wait) await sleep(wait);
        const since = Date.now() - this.lastRequestAt;
        const gap = CONFIG.minIntervalMs - since;
        if (gap > 0) await sleep(gap);
        await sleep(jitter());

        const result = await this._withRetry(task.taskFn);
        this.lastRequestAt = Date.now();
        this.consecutiveBlocks = 0;
        task.resolve(result);
      } catch (e) {
        if (e && e.rateLimited) {
          this.consecutiveBlocks++;
          if (this.consecutiveBlocks >= CONFIG.breakerThreshold) {
            this.breakerUntil = Date.now() + CONFIG.breakerCooldownMs;
          }
        }
        task.reject(e);
      }
    }
    this.running = false;
  }

  async _withRetry(fn) {
    let lastErr;
    for (let i = 0; i < CONFIG.maxRetry; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (!e.retryable) throw e;
        // 指数退避 + 抖动
        await sleep(Math.min(30000, 2000 * 2 ** i) + jitter());
      }
    }
    throw lastErr;
  }
}

/** 统一的 fetch 包装：识别 B站风控响应码 */
export async function biliFetch(url, init = {}) {
  const res = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: {
      'Accept': 'application/json, text/plain, */*',
      ...(init.headers || {}),
    },
  });

  if (res.status === 412) {
    const e = new Error('请求被风控拦截 (412)');
    e.rateLimited = true; e.retryable = false;
    throw e;
  }
  if (res.status === 429 || res.status >= 500) {
    const e = new Error(`服务端繁忙 (${res.status})`);
    e.retryable = true; e.rateLimited = res.status === 429;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`HTTP ${res.status}`);
    e.retryable = false;
    throw e;
  }
  return res;
}

export const LIMITER_CONFIG = CONFIG;



