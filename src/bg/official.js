

/**
 * official.js —— 官方判定核验（零写入）
 *
 * ⚠ 本模块**不发送、不删除、不重放任何评论**，没有任何写操作。
 * 官方判定的来源只有两类，全部是「读」：
 *
 *   1) 被动拦截：用户自己点击发送时，B站官方接口返回的 code 与 rpid
 *      （由 MAIN world 的 intercept.js 旁路读取，评论数量增量为 0）
 *   2) 只读核验：用该 rpid 去公开的评论读接口，比对登录态与游客态的可见性
 *
 * 与旧版「探针评论区」的区别：旧版会主动造一条测试评论再删除；
 * 本版完全不制造评论，只解读用户本来就要发的那一条。
 */

import { biliFetch } from './limiter.js';
import { getWbiKeys, encWbi } from './wbi.js';

/** 官方发评返回码 —— 来源：bilibili-API-collect 社区整理的公开文档 */
export const REPLY_CODES = {
  0:      { key: 'ok',        label: '接口已接受',          level: 'safe', desc: '官方接口已接受，进入后续审核；仍可能被隐藏，需核验可见性。' },
  12016:  { key: 'sensitive', label: '评论内容包含敏感信息', level: 'high', desc: '官方在发送阶段直接拒绝，命中顶级敏感词库。此判定为全站通用，可信度最高。' },
  12015:  { key: 'captcha',   label: '需要评论验证码',      level: 'mid',  desc: '账号已被风控标记，通常意味着近期发言被判定异常。' },
  12051:  { key: 'duplicate', label: '重复评论，请勿刷屏',  level: 'mid',  desc: '触发查重机制，与内容是否敏感无关。' },
  12035:  { key: 'blacklist', label: '被UP主列入评论黑名单', level: 'high', desc: '该UP主已将此账号拉黑。' },
  12002:  { key: 'closed',    label: '评论区已关闭',        level: 'info', desc: '' },
  12052:  { key: 'closed',    label: '评论区已关闭',        level: 'info', desc: '' },
  12003:  { key: 'forbidden', label: '禁止回复',            level: 'info', desc: '' },
  12025:  { key: 'toolong',   label: '评论字数过多',        level: 'mid',  desc: '超出长度上限。' },
  12045:  { key: 'paid',      label: '需购买后才能评论',    level: 'info', desc: '' },
  12006:  { key: 'noreply',   label: '没有该评论',          level: 'info', desc: '' },
  12009:  { key: 'badtype',   label: '评论主体type不合法',  level: 'info', desc: '' },
  '-101': { key: 'nologin',   label: '账号未登录',          level: 'info', desc: '' },
  '-102': { key: 'banned',    label: '账号被封停',          level: 'high', desc: '' },
  '-111': { key: 'csrf',      label: 'csrf校验失败',        level: 'info', desc: '请刷新B站页面后重试。' },
  '-509': { key: 'toofast',   label: '请求过于频繁',        level: 'mid',  desc: '已触发频率限制。' },
  '-400': { key: 'badreq',    label: '请求错误',            level: 'info', desc: '' },
};

export const VERDICT = {
  REJECTED:  'rejected',   // 官方发送阶段直接拒绝
  BLOCKED:   'blocked',    // 因验证码/黑名单/关闭等无法发出
  SHADOWBAN: 'shadowban',  // 发出了但游客不可见
  DELETED:   'deleted',    // 发出后被删除
  VISIBLE:   'visible',    // 游客可见
  PENDING:   'pending',    // 审核中（尚未定论）
  UNKNOWN:   'unknown',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 只读接口 ---------------- */

async function fetchReplyIds({ oid, type, guest }) {
  const mixin = await getWbiKeys((u) => biliFetch(u, { credentials: 'include' }));
  const qs = await encWbi(
    { oid, type, mode: 2, pagination_str: JSON.stringify({ offset: '' }), plat: 1, ps: 20, pn: 1, web_location: 1315875 },
    mixin
  );
  const res = await biliFetch(`https://api.bilibili.com/x/v2/reply/wbi/main?${qs}`, {
    credentials: guest ? 'omit' : 'include',
  });
  const json = await res.json();
  if (json.code !== 0) {
    const e = new Error(json.message || `code=${json.code}`);
    e.retryable = json.code === -509 || json.code === -799;
    e.rateLimited = e.retryable;
    throw e;
  }
  const ids = new Set();
  for (const r of json.data?.replies || []) ids.add(String(r.rpid));
  for (const r of json.data?.top_replies || []) ids.add(String(r.rpid));
  return ids;
}

/** 单条评论详情：区分「已删除」与「仅自己可见」 */
async function replyAlive({ oid, type, rpid, guest }) {
  const res = await biliFetch(
    `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${rpid}&ps=1&pn=1`,
    { credentials: guest ? 'omit' : 'include' }
  );
  const json = await res.json();
  if (json.code === 12006 || json.code === -404) return false;
  return json.code === 0;
}

/** 楼中楼：根评论列表里找不到，需按 root 查 */
async function replyVisibleAsChild({ oid, type, root, rpid, guest }) {
  const res = await biliFetch(
    `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${root}&ps=20&pn=1`,
    { credentials: guest ? 'omit' : 'include' }
  );
  const json = await res.json();
  if (json.code !== 0) return false;
  return (json.data?.replies || []).some((r) => String(r.rpid) === String(rpid));
}

/* ---------------- 判定 ---------------- */

/**
 * 解读被拦截到的发评响应；若已发出，再做只读可见性核验。
 * 全程零写入。
 *
 * @param {object} a
 * @param {number} a.code      官方返回码
 * @param {string} a.rpid      官方返回的评论 id（code=0 时存在）
 * @param {string} a.oid
 * @param {number} a.type
 * @param {string} [a.root]    楼中楼的根评论 id
 * @param {object} a.scheduler 限流队列
 * @param {number} [a.waitMs]  等待审核裁决的时间
 */
export async function judge({ code, rpid, oid, type, root, scheduler, waitMs = 8000 }) {
  const info = REPLY_CODES[code] ?? REPLY_CODES[String(code)] ?? {
    key: 'unknown', label: `未知返回码 ${code}`, level: 'info', desc: '',
  };

  // 1) 发送阶段就被官方拒绝 —— 最强信号，无需核验
  if (code !== 0) {
    const blockedKeys = ['captcha', 'blacklist', 'closed', 'forbidden', 'paid', 'badtype', 'csrf', 'nologin', 'toofast'];
    return {
      verdict: info.key === 'sensitive' ? VERDICT.REJECTED
        : blockedKeys.includes(info.key) ? VERDICT.BLOCKED
        : VERDICT.REJECTED,
      official: true,
      source: 'send-api',
      code,
      codeLabel: info.label,
      codeDesc: info.desc,
      level: info.level,
      needVerify: false,
    };
  }

  // 2) 已被接受：只读核验真实可见性
  if (!rpid) {
    return { verdict: VERDICT.UNKNOWN, official: true, source: 'send-api', code, codeLabel: info.label,
             codeDesc: '接口未返回 rpid，无法核验可见性。', needVerify: false };
  }

  await sleep(waitMs);

  try {
    let guestSees;
    if (root) {
      guestSees = await scheduler.schedule(
        () => replyVisibleAsChild({ oid, type, root, rpid, guest: true }),
        { priority: 2, key: `g-child:${oid}:${root}` }
      );
    } else {
      const ids = await scheduler.schedule(
        () => fetchReplyIds({ oid, type, guest: true }),
        { priority: 2, key: `g-list:${oid}:${type}` }
      );
      guestSees = ids.has(String(rpid));
    }

    if (guestSees) {
      return { verdict: VERDICT.VISIBLE, official: true, source: 'visibility', code: 0,
               codeLabel: '接口已接受', detail: '游客视角可见，这条评论正常展示。' };
    }

    const alive = await scheduler.schedule(
      () => replyAlive({ oid, type, rpid, guest: false }),
      { priority: 2, key: `self:${rpid}` }
    );

    if (!alive) {
      return { verdict: VERDICT.DELETED, official: true, source: 'visibility', code: 0,
               codeLabel: '接口已接受',
               detail: '评论已不存在 —— 发送后被系统删除。' };
    }
    return { verdict: VERDICT.SHADOWBAN, official: true, source: 'visibility', code: 0,
             codeLabel: '接口已接受',
             detail: '登录可见、游客不可见 —— 已被 ShadowBan（仅自己可见），或仍处于审核中。' };
  } catch (e) {
    return { verdict: VERDICT.UNKNOWN, official: true, source: 'visibility', code: 0,
             codeLabel: '接口已接受', detail: `可见性核验失败：${e.message}`,
             rateLimited: !!e.rateLimited };
  }
}

/** 复查：对历史上判为 shadowban/pending 的评论再核验一次（应对「秋后算账」） */
export async function recheck({ rpid, oid, type, root, scheduler }) {
  return judge({ code: 0, rpid, oid, type, root, scheduler, waitMs: 0 });
}



