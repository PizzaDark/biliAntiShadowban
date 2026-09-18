
/**
 * dom.js —— B站评论区 DOM 适配层
 * 兼容普通 DOM、开放 shadow DOM，以及新版评论组件的跨 shadow 边界结构。
 */

/** 深度遍历普通 DOM 与开放 shadow DOM。 */
export function deepQueryAll(selector, root = document, acc = [], depth = 0) {
  if (!root || depth > 20) return acc;
  try { root.querySelectorAll?.(selector)?.forEach((el) => acc.push(el)); } catch { /* noop */ }
  let all = [];
  try { all = root.querySelectorAll?.('*') || []; } catch { /* noop */ }
  for (const el of all) if (el.shadowRoot) deepQueryAll(selector, el.shadowRoot, acc, depth + 1);
  return acc;
}

/** 跨 shadow root 取得逻辑父节点。 */
function composedParent(el) {
  if (!el) return null;
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode?.();
  return root instanceof ShadowRoot ? root.host : null;
}

export function detectPageType() {
  const { host, pathname } = location;
  if (/\/video\/|\/bangumi\/play\//.test(pathname)) return 'video';
  if (host.startsWith('t.') || /\/(?:opus|dynamic)\//.test(pathname)) return 'dynamic';
  if (/\/read\/(?:cv|mobile)/.test(pathname)) return 'article';
  if (host === 'space.bilibili.com' || host.endsWith('.space.bilibili.com')) return 'space';
  return 'other';
}

export function resolveOidType() {
  const p = detectPageType();
  if (p === 'video') {
    const aid = window.__INITIAL_STATE__?.aid || window.__INITIAL_STATE__?.videoData?.aid;
    if (aid) return { oid: String(aid), type: 1 };
    const pageAid = document.querySelector('meta[itemprop="url"]')?.content?.match(/av(\d+)/i)?.[1];
    if (pageAid) return { oid: pageAid, type: 1 };
    // content script 运行在隔离世界，通常读不到页面世界的 window.__INITIAL_STATE__；
    // 从页面内嵌初始 JSON 中回退提取 aid。
    for (const script of document.scripts) {
      const text = script.textContent || '';
      if (!text.includes('videoData') && !text.includes('"aid"')) continue;
      const m = text.match(/"aid"\s*:\s*(\d+)/);
      if (m) return { oid: m[1], type: 1 };
    }
    const bv = location.pathname.match(/\/video\/(BV[\w]+)/)?.[1];
    if (bv) return { oid: null, bvid: bv, type: 1 };
  }
  if (p === 'dynamic') {
    const id = location.pathname.match(/\/(?:opus|dynamic)\/(\d+)/)?.[1];
    if (id) return { oid: id, type: 17 };
  }
  if (p === 'article') {
    const cv = location.pathname.match(/\/read\/cv(\d+)/)?.[1];
    if (cv) return { oid: cv, type: 12 };
  }
  return { oid: null, type: null };
}

function buttonScore(btn) {
  const s = `${btn.textContent || ''} ${btn.className || ''} ${btn.getAttribute?.('aria-label') || ''} ${btn.getAttribute?.('data-testid') || ''}`;
  if (/发布|发送|送出|submit|send/i.test(s)) return 100;
  if (btn.matches?.('bili-comment-send-button, .bili-comment-send-button, .reply-box-send, .comment-submit, button[type="submit"]')) return 80;
  return -1;
}

/** 从编辑器开始逐层跨 shadow 边界向上寻找同一评论框中的发送按钮。 */
function findSendButton(editor) {
  let scope = editor;
  for (let i = 0; scope && i < 12; i++, scope = composedParent(scope)) {
    const cands = deepQueryAll(
      'bili-comment-send-button, .bili-comment-send-button, .reply-box-send, .comment-submit, button[type="submit"], button',
      scope
    );
    const ranked = cands.map((b) => [buttonScore(b), b]).filter(([s]) => s >= 0).sort((a, b) => b[0] - a[0]);
    if (ranked.length) return { button: ranked[0][1], container: scope };
  }
  return null;
}

export function findComposers() {
  const results = [];
  const seenButtons = new WeakSet();
  const seenEditors = new WeakSet();
  const selectors = [
    'bili-comment-rich-textarea', '.brt-editor',
    '.reply-box-textarea', '.comment-send textarea', 'textarea.reply-box-textarea',
    'bili-comments textarea', 'bili-comments [contenteditable="true"]',
    'bili-comment-box textarea', 'bili-comment-box [contenteditable="true"]',
  ].join(',');

  for (const editor of deepQueryAll(selectors)) {
    if (seenEditors.has(editor)) continue;
    seenEditors.add(editor);
    // 内外层编辑器同时命中时优先实际可编辑节点，但保留自定义元素以便读取其 shadow 内容。
    if (editor.matches?.('.brt-editor, [contenteditable="true"]')) {
      const parentEditor = composedParent(editor);
      if (parentEditor?.matches?.('bili-comment-rich-textarea')) continue;
    }
    const found = findSendButton(editor);
    if (!found || seenButtons.has(found.button)) continue;
    seenButtons.add(found.button);
    results.push({ editor, sendBtn: found.button, container: found.container, variant: 'auto' });
  }
  return results;
}

function elementText(el) {
  if (!el) return '';
  if (/^(TEXTAREA|INPUT)$/.test(el.tagName)) return el.value || '';
  return el.innerText || el.textContent || el.value || el.text || '';
}

function deepActiveElement(root = document) {
  let el = root.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

export function readEditorText(editor, container) {
  if (!editor) return '';
  let text = elementText(editor);
  if (text.trim()) return text;

  // 新版输入框的真实 contenteditable 可能不是自定义元素的子节点，而是位于同一层
  // shadow root 中；因此同时搜索编辑器、评论框和当前焦点链。
  const scopes = [editor, editor.getRootNode?.(), container, container?.getRootNode?.()];
  for (const scope of scopes) {
    if (!scope) continue;
    for (const inner of deepQueryAll('textarea, .brt-editor, [contenteditable="true"], [role="textbox"]', scope)) {
      text = elementText(inner);
      if (text.trim()) return text;
    }
  }
  text = elementText(deepActiveElement());
  return text || '';
}

export function readEditorImages(container) {
  return deepQueryAll('img', container).filter((img) => img.src && !/\.svg($|\?)/.test(img.src) && img.naturalWidth > 48).slice(0, 4);
}

function firstValue(node, names) {
  for (const name of names) {
    const v = node.getAttribute?.(name) ?? node.dataset?.[name.replace(/^data-/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase())];
    if (v != null && String(v)) return String(v);
  }
  return null;
}

/** 从元素及其 Shadow DOM/框架属性中提取评论 ID。 */
function rpidFromAttributes(node) {
  if (!node) return null;
  try {
    for (const a of node.attributes || []) {
      // 只接受属性名具有明确 reply/rpid 语义的数字，避免把 uid/时间戳误当评论 ID。
      if (/(?:rpid|reply[-_]?id|comment[-_]?id)/i.test(a.name)) {
        const m = String(a.value).match(/\d{5,}/);
        if (m) return m[0];
      }
    }
  } catch { /* noop */ }
  return null;
}

/** 从 Web Component / Vue / React 挂在元素上的浅层数据中提取 rpid。 */
function rpidFromProps(node) {
  if (!node) return null;
  const direct = [node.rpid, node.replyId, node.__data?.rpid, node.data?.rpid, node.reply?.rpid];
  for (const v of direct) if (/^\d{5,}$/.test(String(v || ''))) return String(v);
  try {
    for (const key of Object.keys(node)) {
      if (!/^(__vue|__react|__data|data|reply)/i.test(key)) continue;
      const obj = node[key];
      const queue = [{ v: obj, d: 0 }];
      const visited = new WeakSet();
      while (queue.length) {
        const { v, d } = queue.shift();
        if (!v || typeof v !== 'object' || d > 3 || visited.has(v)) continue;
        visited.add(v);
        for (const [k, x] of Object.entries(v)) {
          if (/^(rpid|replyId)$/i.test(k) && /^\d{5,}$/.test(String(x || ''))) return String(x);
          if (x && typeof x === 'object') queue.push({ v: x, d: d + 1 });
        }
      }
    }
  } catch { /* 某些框架属性不可枚举/不可访问 */ }
  return null;
}

function findRpid(card) {
  // 1. 优先读取主世界透出的 data-rpid 属性
  const directId = firstValue(card, ['data-rpid', 'rpid', 'data-id']);
  if (directId && /^\d{5,}$/.test(directId)) return String(directId);

  const candidates = [card, ...deepQueryAll('*', card)];
  // Shadow 内的按钮组件往往持有 rpid；外层 thread 组件也可能持有它。
  let up = composedParent(card);
  for (let i = 0; up && i < 4; i++, up = composedParent(up)) candidates.push(up);
  for (const n of candidates) {
    const id = rpidFromAttributes(n) || rpidFromProps(n);
    if (id) return id;
  }
  for (const n of candidates) {
    const raw = `${n.id || ''} ${n.getAttribute?.('href') || ''}`;
    const m = raw.match(/(?:reply|rpid|comment)[-_=/]?(\d{5,})/i);
    if (m) return m[1];
  }
  return null;
}

/** 提取楼中楼的根评论 ID (root rpid) */
export function findRootRpid(card) {
  let n = card;
  for (let i = 0; n && i < 10; i++, n = composedParent(n)) {
    const rootId = firstValue(n, ['data-root-rpid', 'data-root', 'root-id']);
    if (rootId && /^\d{5,}$/.test(rootId)) return String(rootId);
    if (n !== card && n.matches?.('bili-comment-thread-renderer, .root-reply-container, .root-reply')) {
      const id = firstValue(n, ['data-rpid', 'rpid', 'data-id']) || findRpid(n);
      if (id && /^\d{5,}$/.test(id) && id !== findRpid(card)) return String(id);
    }
  }
  return null;
}

/** 清洗提取评论卡片中的真实正文，剥离用户名、时间戳、IP属地、操作按钮与徽标干扰 */
export function extractCommentCleanText(card) {
  if (!card) return '';
  const richContainers = deepQueryAll('bili-rich-text, #content #contents, .reply-content, .text-con, .con', card);
  const targetScope = richContainers.length > 0 ? richContainers : [card.shadowRoot || card];

  const textParts = [];
  const collect = (root, depth = 0) => {
    if (!root || depth > 8) return;
    if (root.nodeType === 1) { // ELEMENT_NODE
      const tag = (root.localName || '').toLowerCase();
      const cls = typeof root.className === 'string' ? root.className : '';
      const id = root.id || '';
      if (root.getAttribute?.('data-bsc') || cls.includes('bsc-badge')) return;
      if (/user-info|action-buttons|reply-info|header|footer/i.test(tag)) return;
      if (/(?:^|\s)(?:user-name|reply-info|action-buttons|sub-reply-item|operation-btn)(?:\s|$)/i.test(cls)) return;
      if (/^(user-name|reply-tags|footer)$/i.test(id)) return;
      // 表情图标往往带有 alt 标签（如 [doge]）
      if (tag === 'img' && root.alt) {
        textParts.push(root.alt);
        return;
      }
    }
    if (root.nodeType === 3) { // TEXT_NODE
      const s = root.textContent?.trim();
      if (s) textParts.push(s);
      return;
    }
    for (const child of root.childNodes || []) collect(child, depth + 1);
    for (const el of root.querySelectorAll?.('*') || []) if (el.shadowRoot) collect(el.shadowRoot, depth + 1);
  };

  for (const s of targetScope) collect(s);
  const full = textParts.join(' ').replace(/^(?:回复|回覆|Reply(?:\s+to)?)\s+@?[^\s:：]+(?:\s*[:：]\s*|\s+)/iu, '').trim();
  return full.slice(0, 500);
}

export function findMyComments(myUid) {
  const out = [];
  if (!myUid) return out;
  const seen = new WeakSet();

  // 必须遍历全局 DOM 与 Shadow DOM，找到属于自己的作者链接
  const links = deepQueryAll(`a[href*="space.bilibili.com/${myUid}"]`);

  const exactCardSelector = [
    'bili-comment-renderer', 'bili-comment-reply-renderer', 'bili-comment-sub-reply-renderer',
    '.sub-reply-item', '.root-reply-container', '.root-reply',
    '.reply-item', '.list-item.reply-wrap'
  ].join(',');

  for (const link of links) {
    // 排除页面顶栏头像、个人信息卡等非评论作者链接。
    if (link.closest?.('header, nav, .bili-header, .mini-header, [class*="header"]')) continue;

    let card = null;
    let n = link;
    for (let i = 0; n && i < 15; i++, n = composedParent(n)) {
      const tag = (n.localName || '').toLowerCase();
      // 严禁停在头像、用户信息卡、富文本、操作栏等内部子组件上（彻底杜绝徽标挂在头像上）
      if (/(?:user-info|avatar|action-buttons|rich-text|pictures)/i.test(tag)) continue;

      // 1. Web Components 单条卡片（主评或子评）
      if (tag === 'bili-comment-renderer' || tag === 'bili-comment-reply-renderer' || tag === 'bili-comment-sub-reply-renderer') {
        card = n;
        break;
      }

      // 2. 传统 DOM
      if (n.matches?.(exactCardSelector)) {
        card = n;
        break;
      }

      // 3. 楼层根组件 bili-comment-thread-renderer（若其内部无 bili-comment-renderer 时的备选）
      if (tag === 'bili-comment-thread-renderer' || tag === 'bili-comment-thread') {
        const innerRoot = n.shadowRoot?.querySelector('bili-comment-renderer');
        card = innerRoot || n;
        break;
      }
    }
    if (!card || seen.has(card)) continue;
    seen.add(card);

    let rpid = findRpid(card);
    if (!rpid) rpid = firstValue(card, ['data-rpid', 'rpid', 'data-id']);
    const root = findRootRpid(card);

    // textContent 不会穿透 Shadow DOM，递归收集正文供后续诊断/接口回退使用。
    const cleanText = extractCommentCleanText(card);
    const textParts = [];
    if (!cleanText) {
      const textNodeType = typeof Node !== 'undefined' ? Node.TEXT_NODE : 3;
      const collectText = (rootNode, depth = 0) => {
        if (!rootNode || depth > 8) return;
        if (rootNode.nodeType === textNodeType) { if (rootNode.textContent?.trim()) textParts.push(rootNode.textContent.trim()); return; }
        for (const child of rootNode.childNodes || []) collectText(child, depth + 1);
        for (const el of rootNode.querySelectorAll?.('*') || []) if (el.shadowRoot) collectText(el.shadowRoot, depth + 1);
      };
      collectText(card.shadowRoot || card);
    }
    const text = cleanText || textParts.join(' ').slice(0, 500);
    out.push({ el: card, rpid, root, uid: String(myUid), text });
  }
  return out;
}


