

/**
 * intercept.js —— 被动拦截（页面世界 / MAIN world）
 *
 * 设计原则：**不制造任何评论**。
 * 本模块不发送、不删除、不重放任何请求，只是在页面自身发起发评请求时，
 * 旁路读取 B站官方的响应内容（返回码 + rpid），再转交给扩展解读。
 *
 * 也就是说：用户本来就要发这条评论，我们只是把官方对它的判决「翻译」出来。
 * 相比「探针评论区」方案，这里的评论数量增量为 0。
 *
 * 注入方式：MAIN world content script，包装 window.fetch 与 XMLHttpRequest，
 * 仅匹配评论相关端点，其余请求原样放行、不读取、不修改。
 */

(() => {
  if (window.__BAS_HOOKED__) return;
  window.__BAS_HOOKED__ = true;

  const SEND_RE  = /\/x\/v2\/reply\/(add|reply\/add)/;      // 发评
  const DEL_RE   = /\/x\/v2\/reply\/del/;                    // 删评（由用户自己触发）
  const LIST_RE  = /\/x\/v2\/reply\/(?:wbi\/main|main|reply)/; // 评论列表
  const CHANNEL  = '__BAS_MSG__';

  const post = (payload) => {
    try { window.postMessage({ __bas: true, ...payload }, location.origin); } catch { /* noop */ }
  };

  /** 从请求体里取出用户实际发送的文本与目标评论区 */
  function parseBody(body) {
    try {
      if (!body) return {};
      let s = '';
      if (typeof body === 'string') s = body;
      else if (body instanceof URLSearchParams) s = body.toString();
      else if (body instanceof FormData) {
        const o = {};
        for (const [k, v] of body.entries()) o[k] = v;
        return o;
      } else return {};
      const p = new URLSearchParams(s);
      const o = {};
      for (const [k, v] of p.entries()) o[k] = v;
      return o;
    } catch { return {}; }
  }

  function handleSend(url, bodyObj, json) {
    post({
      type: 'REPLY_SENT',
      url,
      oid: bodyObj.oid, rtype: bodyObj.type, root: bodyObj.root, parent: bodyObj.parent,
      message: bodyObj.message,
      code: json?.code,
      apiMessage: json?.message,
      rpid: json?.data?.rpid ?? json?.data?.reply?.rpid ?? null,
      at: Date.now(),
    });
  }

  function handleRepliesList(json) {
    try {
      if (!json || json.code !== 0 || !json.data) return;
      const replies = [];
      const walk = (list) => {
        for (const r of list || []) {
          if (r.rpid) {
            replies.push({
              rpid: String(r.rpid),
              root: r.root ? String(r.root) : undefined,
              mid: String(r.mid ?? r.member?.mid ?? ''),
              message: String(r.content?.message || ''),
            });
          }
          if (r.replies) walk(r.replies);
        }
      };
      walk(json.data.replies);
      walk(json.data.top_replies);
      if (json.data.root) walk([json.data.root]);
      if (replies.length > 0) {
        post({ type: 'REPLIES_CACHED', replies });
      }
    } catch {}
  }

  // 拦截 Web Components 组件生命周期：将 rpid 透出为 DOM 属性 data-rpid / data-root-rpid
  // 运行在 ISOLATED world 的 content script 即可直接读取，无需跨沙箱或网络回查
  function stampElement(el) {
    if (!el || el.nodeType !== 1) return;
    try {
      const d = el.data || el.reply || el.replyItem;
      const rpid = d?.rpid_str || d?.rpid;
      if (rpid && el.getAttribute('data-rpid') !== String(rpid)) {
        el.setAttribute('data-rpid', String(rpid));
      }
      const root = d?.root_str || d?.root;
      if (root && el.getAttribute('data-root-rpid') !== String(root)) {
        el.setAttribute('data-root-rpid', String(root));
      }
    } catch {}
  }

  function patchCustomElement(ctor) {
    if (!ctor || typeof ctor !== 'function') return;
    const proto = ctor.prototype;
    if (!proto || proto.__basPatched) return;
    proto.__basPatched = true;

    for (const method of ['update', 'updated', 'connectedCallback']) {
      const orig = proto[method];
      if (typeof orig === 'function') {
        proto[method] = function (...args) {
          const res = orig.apply(this, args);
          stampElement(this);
          return res;
        };
      }
    }
  }

  if (typeof window !== 'undefined' && window.customElements) {
    try {
      const origDefine = window.customElements.define;
      window.customElements.define = function (name, ctor, ...rest) {
        // 只拦截主评论与子评论卡片组件，绝不拦截 user-info/avatar，防止徽标挂在头像上
        if (/^bili-comment-(?:reply-renderer|renderer|thread-renderer)$/i.test(name)) {
          patchCustomElement(ctor);
        }
        return origDefine.call(this, name, ctor, ...rest);
      };

      const existingNames = ['bili-comment-reply-renderer', 'bili-comment-renderer', 'bili-comment-thread-renderer'];
      for (const name of existingNames) {
        const c = window.customElements.get(name);
        if (c) patchCustomElement(c);
      }
    } catch {}
  }

  /* ---------- fetch ---------- */
  const rawFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await rawFetch.apply(this, args);
    try {
      const req = args[0];
      const url = typeof req === 'string' ? req : req?.url || '';
      if (SEND_RE.test(url)) {
        const init = args[1] || {};
        let bodyObj = parseBody(init.body);
        // Request 对象形式
        if (!bodyObj.message && req instanceof Request) {
          try { bodyObj = parseBody(await req.clone().text()); } catch { /* noop */ }
        }
        res.clone().json().then((j) => handleSend(url, bodyObj, j)).catch(() => {});
      } else if (DEL_RE.test(url)) {
        const b = parseBody((args[1] || {}).body);
        if (b.rpid) post({ type: 'REPLY_DELETED', rpid: String(b.rpid) });
      } else if (LIST_RE.test(url)) {
        res.clone().json().then((j) => handleRepliesList(j)).catch(() => {});
      }
    } catch { /* 绝不影响原请求 */ }
    return res;
  };

  /* ---------- XMLHttpRequest ---------- */
  const rawOpen = XMLHttpRequest.prototype.open;
  const rawSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__basUrl = url;
    return rawOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      const url = this.__basUrl || '';
      if (SEND_RE.test(url)) {
        const bodyObj = parseBody(body);
        this.addEventListener('load', () => {
          try { handleSend(url, bodyObj, JSON.parse(this.responseText)); } catch { /* noop */ }
        });
      } else if (DEL_RE.test(url)) {
        const b = parseBody(body);
        if (b.rpid) post({ type: 'REPLY_DELETED', rpid: String(b.rpid) });
      } else if (LIST_RE.test(url)) {
        this.addEventListener('load', () => {
          try { handleRepliesList(JSON.parse(this.responseText)); } catch { /* noop */ }
        });
      }
    } catch { /* noop */ }
    return rawSend.call(this, body);
  };

  post({ type: 'HOOK_READY' });
})();



