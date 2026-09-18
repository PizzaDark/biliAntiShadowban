
/**
 * visibility.js —— 判断「自己发过的评论，别人是否可见」
 *
 * 原理（完全基于公开只读接口，不做任何写操作）：
 *   B站「仅自己可见」的评论（被审核拦截 / 被 UP 主删除 / 被折叠）有一个典型特征：
 *   带着登录 Cookie 请求评论详情/列表时能看到该条，而以「游客视角」（不带 Cookie / 无凭证）
 *   请求时该条不存在（返回 12006 或不在列表中）。
 *
 * 实现要点：
 *   - 登录视角：后台 credentials:'include'
 *   - 游客视角：后台 credentials:'omit'
 *   - 支持基于 Cursor 的 pagination_str 游标翻页，支持按最新 (mode 2) 与最热 (mode 3) 查验
 *   - 优先通过 /x/v2/reply/reply 单条根评论/楼中楼直接核验，极大减少翻页请求
 *   - 两次请求都受 Scheduler 限流，且结果缓存，避免重复探测
 */

import { biliFetch } from './limiter.js';
import { getWbiKeys, encWbi } from './wbi.js';

const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map(); // rpid -> {status, ts}

export const VISIBILITY = {
  VISIBLE: 'visible',       // 他人可见
  SELF_ONLY: 'self_only',   // 仅自己可见
  FOLDED: 'folded',         // 被折叠（他人需展开才可见）
  UNKNOWN: 'unknown',
};

function cacheGet(rpid) {
  const c = cache.get(rpid);
  if (c && Date.now() - c.ts < CACHE_TTL) return c.status;
  return null;
}

function cacheSet(rpid, status) {
  cache.set(rpid, { status, ts: Date.now() });
  if (cache.size > 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(0, 100);
    oldest.forEach(([k]) => cache.delete(k));
  }
}

/**
 * 拉取一页评论（支持游标 Cursor 与模式切换）
 * @param {object} opt
 * @param {string} opt.oid
 * @param {number} opt.type
 * @param {number} [opt.mode] - 2: 最新 (时间倒序), 3: 最热 (热度排序)
 * @param {string} [opt.offset] - 游标 offset
 * @param {number} [opt.ps]
 * @param {'login'|'guest'} [opt.sessionMode]
 */
export async function fetchCommentPage({ oid, type, mode = 2, offset = '', ps = 20, sessionMode = 'login' }) {
  const mixin = await getWbiKeys((u) => biliFetch(u, { credentials: 'include' }));
  const pagination_str = JSON.stringify({ offset: offset || '' });
  const qs = await encWbi(
    { oid, type, mode, pagination_str, plat: 1, ps, web_location: 1315875 },
    mixin
  );
  const url = `https://api.bilibili.com/x/v2/reply/wbi/main?${qs}`;
  const res = await biliFetch(url, {
    credentials: sessionMode === 'guest' ? 'omit' : 'include',
  });
  const json = await res.json();
  if (json.code !== 0) {
    const e = new Error(json.message || `接口返回 code=${json.code}`);
    e.retryable = json.code === -509 || json.code === -799;
    e.rateLimited = e.retryable;
    throw e;
  }
  const data = json.data || {};
  const nextOffset = data.cursor?.pagination_reply?.next_offset ?? data.cursor?.next ?? '';
  const isEnd = !!data.cursor?.is_end || !nextOffset;
  return { data, nextOffset, isEnd };
}

/** 拉取指定根评论的楼中楼二级回复列表 */
export async function fetchSubReplies({ oid, type, root, pn = 1, ps = 20, sessionMode = 'login' }) {
  const url = `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${root}&ps=${ps}&pn=${pn}`;
  const res = await biliFetch(url, {
    credentials: sessionMode === 'guest' ? 'omit' : 'include',
  });
  const json = await res.json();
  if (json.code !== 0) return { replies: [], isEnd: true };
  const replies = json.data?.replies || [];
  return { replies, isEnd: replies.length === 0 };
}

function normalizeForMatch(s) {
  if (!s) return '';
  return String(s)
    .replace(/\[[^\]]+\]/g, '') // 去除表情标签
    .replace(/[^\p{L}\p{N}]/gu, '') // 去除标点与空白
    .toLowerCase();
}

function isMatch(targetRaw, msgRaw) {
  const t1 = String(targetRaw || '').replace(/\s+/g, '').toLowerCase();
  const m1 = String(msgRaw || '').replace(/\s+/g, '').toLowerCase();
  if (!t1 || !m1) return false;
  if (t1.includes(m1) || m1.includes(t1)) return true;

  const t2 = normalizeForMatch(targetRaw);
  const m2 = normalizeForMatch(msgRaw);
  if (t2 && m2 && (t2.includes(m2) || m2.includes(t2))) return true;

  // 长文本片段重合度判定
  const s = t2.length < m2.length ? t2 : m2;
  const l = t2.length < m2.length ? m2 : t2;
  if (s.length >= 6) {
    const seg = s.slice(0, Math.floor(s.length * 0.75));
    if (l.includes(seg)) return true;
  }
  return false;
}

/**
 * DOM 未暴露 rpid 时，按当前账号 UID 与评论正文从只读列表中回查。
 * 策略：
 *   1. 若传入了 root（二级评论/楼中楼），直接查该 root 下的子评论
 *   2. 查主评论：优先查 mode: 2（最新评论/时间倒序），再查 mode: 3（热度排序）
 *   3. 逐页推进真实 Cursor 分页，避免重复拉取第一页
 */
export async function resolveReplyId({ oid, type, uid, text, root, scheduler, maxPages = 5 }) {
  if (!text && !root) return null;

  const match = (r) => {
    const mid = String(r.mid ?? r.member?.mid ?? '');
    if (mid !== String(uid)) return false;
    return isMatch(text, r.content?.message);
  };

  // 1) 若已知为楼中楼子回复，直接查对应楼层的二级评论
  if (root) {
    for (let pn = 1; pn <= Math.min(maxPages, 5); pn++) {
      const { replies, isEnd } = await scheduler.schedule(
        () => fetchSubReplies({ oid, type, root, pn, sessionMode: 'login' }),
        { priority: 4, key: `resolve-sub:${oid}:${root}:${pn}` }
      );
      for (const r of replies) {
        if (match(r)) return String(r.rpid);
      }
      if (isEnd) break;
    }
  }

  // 2) 查主评论列表：优先 mode: 2 (按时间倒序)，再查 mode: 3 (按热度排序)
  for (const sortMode of [2, 3]) {
    let offset = '';
    for (let page = 1; page <= maxPages; page++) {
      const curOffset = offset;
      const res = await scheduler.schedule(
        () => fetchCommentPage({ oid, type, mode: sortMode, offset: curOffset, sessionMode: 'login' }),
        { priority: 4, key: `resolve-rpid:${oid}:${type}:m${sortMode}:p${page}` }
      );
      const list = [...(res.data.replies || []), ...(res.data.top_replies || [])];
      const walk = (items) => {
        for (const r of items || []) {
          if (match(r)) return String(r.rpid);
          const child = walk(r.replies);
          if (child) return child;
        }
        return null;
      };
      const found = walk(list);
      if (found) return found;

      if (res.isEnd || !res.nextOffset || res.nextOffset === offset) break;
      offset = res.nextOffset;
    }
  }
  return null;
}

/**
 * 校验评论可见性：比对登录视角与游客视角
 * 优先采用单条只读核验（/x/v2/reply/reply），精准快速且不依赖分页
 * @param {{oid:string,type:number,rpid:string,root?:string,scheduler:any}} args
 */
export async function checkVisibility({ oid, type, rpid, root, scheduler }) {
  const cached = cacheGet(rpid);
  if (cached) return { status: cached, cached: true };

  try {
    let seenByGuest = false;
    let seenByMe = false;

    // 1) 楼中楼子回复：按 root 查询子评论列表
    if (root && String(root) !== String(rpid)) {
      seenByGuest = await scheduler.schedule(
        async () => {
          const res = await biliFetch(
            `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${root}&ps=20&pn=1`,
            { credentials: 'omit' }
          );
          const j = await res.json();
          return (j.data?.replies || []).some((r) => String(r.rpid) === String(rpid));
        },
        { priority: 6, key: `g-sub-vis:${oid}:${root}:${rpid}` }
      );

      if (seenByGuest) {
        cacheSet(rpid, VISIBILITY.VISIBLE);
        return { status: VISIBILITY.VISIBLE, cached: false };
      }

      seenByMe = await scheduler.schedule(
        async () => {
          const res = await biliFetch(
            `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${root}&ps=20&pn=1`,
            { credentials: 'include' }
          );
          const j = await res.json();
          return (j.data?.replies || []).some((r) => String(r.rpid) === String(rpid));
        },
        { priority: 6, key: `m-sub-vis:${oid}:${root}:${rpid}` }
      );
    } else {
      // 2) 根评论：通过 /reply/reply?root=${rpid} 单条只读比对
      seenByGuest = await scheduler.schedule(
        async () => {
          const res = await biliFetch(
            `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${rpid}&ps=1&pn=1`,
            { credentials: 'omit' }
          );
          const j = await res.json();
          return j.code === 0;
        },
        { priority: 6, key: `g-single-vis:${rpid}` }
      );

      if (seenByGuest) {
        cacheSet(rpid, VISIBILITY.VISIBLE);
        return { status: VISIBILITY.VISIBLE, cached: false };
      }

      seenByMe = await scheduler.schedule(
        async () => {
          const res = await biliFetch(
            `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${rpid}&ps=1&pn=1`,
            { credentials: 'include' }
          );
          const j = await res.json();
          return j.code === 0;
        },
        { priority: 6, key: `m-single-vis:${rpid}` }
      );
    }

    let status = VISIBILITY.UNKNOWN;
    if (seenByGuest) status = VISIBILITY.VISIBLE;
    else if (seenByMe) status = VISIBILITY.SELF_ONLY;

    cacheSet(rpid, status);
    return { status, cached: false };
  } catch (e) {
    return { status: VISIBILITY.UNKNOWN, error: e.message, rateLimited: !!e.rateLimited };
  }
}
