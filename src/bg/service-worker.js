

/**
 * service-worker.js —— 后台协调层
 * 所有网络请求集中在此，保证同一浏览器实例内「全局唯一队列」，
 * 多标签页并发也不会放大请求量。
 */

import { Scheduler, biliFetch, LIMITER_CONFIG } from './limiter.js';
import { checkVisibility, resolveReplyId } from './visibility.js';
import { judge, recheck } from './official.js';

const api = globalThis.browser ?? globalThis.chrome;
const scheduler = new Scheduler();

/* 默认全部功能开启（由作者指定的分发默认值）。
   注意：harmonizeAck 预置为 true 表示风险提示默认已确认，
   风险说明仍在设置页与面板中完整展示，用户可随时关闭。 */
const DEFAULT_SETTINGS = {
  enableVisibility: true,
  enableImage: true,
  autoCheck: false,
  whitelist: [],
  // 和谐处理
  enableHarmonize: true,
  harmonizeMode: 'mixed',                    // 默认：混合（优先同音字）
  harmonizeLevels: ['high', 'mid', 'low'],   // 默认：全部命中
  harmonizeAck: true,
  // 官方判定核验（零写入）
  enableVerify: true,
  verifyWaitMs: 8000,
};

async function getSettings() {
  const s = await api.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
}

/** 登录状态缓存：成功缓存 30 分钟；失败只缓存 30 秒，便于用户登录后快速反映 */
let meCache = { data: null, ts: 0, ttl: 0 };

async function getMe(force = false) {
  if (!force && meCache.data && Date.now() - meCache.ts < meCache.ttl) return meCache.data;
  try {
    const res = await scheduler.schedule(
      () => biliFetch('https://api.bilibili.com/x/web-interface/nav'),
      { priority: 1, key: 'nav' }
    );
    const json = await res.json();
    const data = json?.data?.isLogin
      ? { isLogin: true, mid: json.data.mid, uname: json.data.uname }
      : { isLogin: false };
    meCache = { data, ts: Date.now(), ttl: data.isLogin ? 30 * 60 * 1000 : 30 * 1000 };
    return data;
  } catch (e) {
    const data = { isLogin: false, error: e.message };
    meCache = { data, ts: Date.now(), ttl: 15 * 1000 };
    return data;
  }
}

/* 说明：本扩展不申请 cookies 权限，无法监听登录态变化事件，
   因此改用「未登录只缓存 30 秒」的短 TTL 策略，登录后弹窗会很快反映出来。 */

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'GET_SETTINGS':
          return sendResponse({ ok: true, data: await getSettings() });

        case 'SET_SETTINGS': {
          const cur = await getSettings();
          const next = { ...cur, ...msg.payload };
          await api.storage.local.set({ settings: next });
          return sendResponse({ ok: true, data: next });
        }

        case 'GET_ME':
          return sendResponse({ ok: true, data: await getMe() });

        case 'RESOLVE_OID': {
          const bvid = String(msg.payload?.bvid || '');
          if (!/^BV[\w]+$/i.test(bvid)) return sendResponse({ ok: false, error: '无效 bvid' });
          const data = await scheduler.schedule(async () => {
            const res = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`);
            const json = await res.json();
            if (json.code !== 0 || !json.data?.aid) throw new Error(json.message || '无法解析视频 aid');
            return { oid: String(json.data.aid), type: 1 };
          }, { priority: 1, key: `resolve:${bvid}` });
          return sendResponse({ ok: true, data });
        }

        case 'RESOLVE_RPID': {
          const me = await getMe();
          if (!me.isLogin) return sendResponse({ ok: false, error: '未登录' });
          const rpid = await resolveReplyId({ ...msg.payload, uid: me.mid, scheduler });
          return sendResponse(rpid ? { ok: true, data: { rpid } } : { ok: false, error: '在当前评论分页中未找到该评论' });
        }

        case 'CHECK_VISIBILITY': {
          const s = await getSettings();
          if (!s.enableVisibility) return sendResponse({ ok: true, data: { status: 'unknown', error: '功能已关闭' } });
          const me = await getMe();
          if (!me.isLogin) return sendResponse({ ok: true, data: { status: 'unknown', error: '未登录' } });
          const data = await checkVisibility({ ...msg.payload, scheduler });
          return sendResponse({ ok: true, data });
        }

        case 'JUDGE_REPLY': {
          const st = await getSettings();
          if (!st.enableVerify) return sendResponse({ ok: false, error: '官方判定核验已关闭' });
          const data = await judge({ ...msg.payload, scheduler, waitMs: st.verifyWaitMs });
          return sendResponse({ ok: true, data });
        }

        case 'RECHECK_REPLY': {
          const data = await recheck({ ...msg.payload, scheduler });
          return sendResponse({ ok: true, data });
        }

        case 'GET_STATUS':
          return sendResponse({
            ok: true,
            data: { scheduler: scheduler.state, config: LIMITER_CONFIG, me: await getMe() },
          });

        default:
          return sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true; // 异步响应
});

/** 设置迁移：全部功能默认开启。
 *  老版本用户存档里 enableHarmonize/harmonizeAck 可能为 false（旧默认值），
 *  这里一次性补齐为新默认值，避免升级后仍是关闭状态。 */
const SETTINGS_SCHEMA = 2;

async function migrateSettings() {
  const cur = await api.storage.local.get(['settings', 'schema']);
  if (!cur.settings) {
    await api.storage.local.set({ settings: DEFAULT_SETTINGS, schema: SETTINGS_SCHEMA });
    return;
  }
  if ((cur.schema || 1) < SETTINGS_SCHEMA) {
    const next = {
      ...DEFAULT_SETTINGS,
      ...cur.settings,
      // 强制采用新默认：功能全开、混合模式、全部范围
      enableVisibility: true,
      enableImage: true,
      enableVerify: true,
      enableHarmonize: true,
      harmonizeAck: true,
      harmonizeMode: cur.settings.harmonizeMode || 'mixed',
      harmonizeLevels: ['high', 'mid', 'low'],
    };
    await api.storage.local.set({ settings: next, schema: SETTINGS_SCHEMA });
  }
}

api.runtime.onStartup?.addListener(migrateSettings);

api.runtime.onInstalled.addListener(async (details) => {
  await migrateSettings();
  if (details.reason === 'install') {
    api.tabs.create({ url: api.runtime.getURL('src/ui/options/options.html#welcome') });
  }
});



