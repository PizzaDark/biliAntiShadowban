

/**
 * main.js —— 内容脚本入口
 * 职责：注入「敏感检测」按钮、渲染结果面板、为自己的历史评论挂可见性徽标。
 * 全部 DOM 均加 bsc- 前缀与 data-bsc 标记，不修改B站原有节点结构与行为。
 */

import { loadRules, detect, suggestRewrite } from '../core/detector.js';
import { analyzeImage } from '../core/image.js';
import {
  loadHomophones, harmonizeText, revealZeroWidth, countZeroWidth,
} from '../core/harmonize.js';
import {
  findComposers, readEditorText, readEditorImages,
  findMyComments, resolveOidType, detectPageType, deepQueryAll,
} from './dom.js';

const api = globalThis.browser ?? globalThis.chrome;
const AUTHOR_URL = 'https://space.bilibili.com/6297797';
let settings = {
  enableVisibility: true, enableImage: true, whitelist: [], autoCheck: false,
  enableHarmonize: true, harmonizeMode: 'mixed', harmonizeLevels: ['high', 'mid', 'low'],
  harmonizeAck: true,
  enableVerify: true, verifyWaitMs: 8000, verifyAutoRecheck: true,
};
let myUid = null;
let pageCtx = { oid: null, type: null };

/* ---------------- 工具 ---------------- */
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function send(type, payload) {
  return new Promise((resolve) => {
    try {
      api.runtime.sendMessage({ type, payload }, (resp) => {
        if (api.runtime.lastError) return resolve({ ok: false, error: api.runtime.lastError.message });
        resolve(resp || { ok: false, error: 'no response' });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

/* ---------------- 结果面板 ---------------- */
let panelEl = null;

function closePanel() { panelEl?.remove(); panelEl = null; }

function renderHighlighted(raw, findings) {
  if (!findings.length) return escapeHtml(raw);
  let html = '';
  let cursor = 0;
  for (const f of findings) {
    if (f.start < cursor) continue;
    html += escapeHtml(raw.slice(cursor, f.start));
    html += `<span class="bsc-hl" data-level="${f.level}">${escapeHtml(raw.slice(f.start, f.end))}</span>`;
    cursor = f.end;
  }
  html += escapeHtml(raw.slice(cursor));
  return html;
}

function showPanel(anchor, result, raw, imageResults) {
  closePanel();
  const { level, findings, visibilityRisk } = result;
  const levelText = { high: '高风险', mid: '中风险', low: '低风险', safe: '未见明显风险' }[level];

  const imgFindings = (imageResults || []).flatMap((r, i) =>
    r.findings.map((f) => ({ ...f, imgIndex: i + 1 }))
  );

  const items = [
    ...findings.map((f) => `
      <div class="bsc-item">
        <div class="bsc-item-title">
          <span class="bsc-tag" data-level="${f.level}">${f.categoryLabel}</span>
          ${escapeHtml(f.message)}
        </div>
        <div class="bsc-pos">位置：第 ${f.start + 1}${f.end - f.start > 1 ? `-${f.end}` : ''} 个字符 →「${escapeHtml(f.matched)}」</div>
        <div class="bsc-advice">建议：${escapeHtml(f.advice)}</div>
      </div>`),
    ...imgFindings.map((f) => `
      <div class="bsc-item">
        <div class="bsc-item-title">
          <span class="bsc-tag" data-level="${f.level}">图片${f.imgIndex}</span>
          ${escapeHtml(f.message)}
        </div>
        <div class="bsc-advice">建议：${escapeHtml(f.advice)}</div>
      </div>`),
  ].join('');

  const rewrite = suggestRewrite(raw, findings);

  const el = document.createElement('div');
  el.className = 'bsc-panel';
  el.setAttribute('data-bsc', 'panel');
  el.innerHTML = `
    <div class="bsc-panel-head">
      <span>发布前自查结果</span>
      <span class="bsc-panel-close" data-act="close">✕</span>
    </div>
    <div class="bsc-panel-body">
      <div class="bsc-section-tag bsc-guess">
        本地推测 · 非官方结果
        <span class="bsc-help" title="以下结果来自扩展内置的启发式词库，不是B站官方审核结论。B站的阿瓦隆词库保密且随评论区、账号等级动态变化，无法在发送前读取。仅供参考。">ⓘ</span>
      </div>
      <div class="bsc-verdict" data-level="${level}">
        <b>${levelText}</b> · ${escapeHtml(visibilityRisk)}
        ${findings.length || imgFindings.length ? `（文本 ${findings.length} 处、图片 ${imgFindings.length} 处）` : ''}
      </div>
      ${raw ? `<div class="bsc-preview">${renderHighlighted(raw, findings)}</div>` : ''}
      ${items || '<div class="bsc-advice">未命中本地规则。注意：本结果为本地启发式自查，不代表B站官方审核结论。</div>'}
      ${findings.length ? `
        <div class="bsc-sub">建议修改（删除/打码）</div>
        <div class="bsc-preview">${escapeHtml(rewrite) || '（建议删除全部违规内容后重写）'}</div>
        <div class="bsc-actions">
          <button class="bsc-mini" data-act="copy">复制建议文案</button>
          <button class="bsc-mini" data-act="apply">替换到输入框</button>
        </div>
        ${settings.enableVerify ? `
        <div class="bsc-official">
          <div class="bsc-section-tag bsc-real">
            官方判定核验
            <span class="bsc-help" title="本扩展不会代你发送任何评论。当你自己点击发送后，扩展会读取B站官方接口对这条评论的返回码，并在数秒后用只读接口比对游客视角，判断是否被 ShadowBan。全程零写入。">ⓘ</span>
          </div>
          <div class="bsc-probe-out">
            本扩展<b>不制造任何评论</b>。你点击B站的发送按钮后，
            这里会自动弹出官方对该评论的真实判定（返回码 + 是否被 ShadowBan）。
          </div>
        </div>` : ''}
        ${settings.enableHarmonize ? `
        <div class="bsc-harm">
          <div class="bsc-sub">
            和谐处理
            <span class="bsc-help" title="改写文本以降低被自动识别的概率。这不会让违规内容变得合规，平台仍可能通过语义模型或人工审核判定违规，且刻意规避审核本身可能违反平台规则。请自行评估风险。">ⓘ</span>
          </div>
          <div class="bsc-modes">
            <label><input type="radio" name="bsc-mode" value="homophone" ${settings.harmonizeMode === 'homophone' ? 'checked' : ''}>同音字</label>
            <label><input type="radio" name="bsc-mode" value="zerowidth" ${settings.harmonizeMode === 'zerowidth' ? 'checked' : ''}>零宽字符</label>
            <label><input type="radio" name="bsc-mode" value="mixed" ${settings.harmonizeMode === 'mixed' ? 'checked' : ''}>混合</label>
          </div>
          <div class="bsc-preview bsc-harm-out" data-role="harm-out"></div>
          <div class="bsc-harm-note" data-role="harm-note"></div>
          <div class="bsc-actions">
            <button class="bsc-mini" data-act="harm-refresh">换一批</button>
            <button class="bsc-mini" data-act="harm-copy">复制</button>
            <button class="bsc-mini bsc-primary" data-act="harm-apply">替换到输入框</button>
          </div>
          <div class="bsc-risk">⚠ 规避审核可能违反平台规则并加重处罚，风险自负。</div>
        </div>` : ''}` : ''}
    </div>
    <div class="bsc-foot">
      本地检测 · 不上传任何内容 · 插件作者
      <a href="${AUTHOR_URL}" target="_blank" rel="noopener noreferrer">@依然匹萨吧</a>
    </div>`;

  document.body.appendChild(el);
  const rect = anchor.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 8;
  let left = window.scrollX + rect.left;
  if (left + 380 > window.innerWidth) left = window.innerWidth - 380;
  el.style.top = `${top}px`;
  el.style.left = `${Math.max(8, left)}px`;

  /* ---- 和谐处理：渲染与交互 ---- */
  let harmVariant = 0;
  let harmText = '';

  const renderHarmonized = () => {
    const out = el.querySelector('[data-role="harm-out"]');
    const note = el.querySelector('[data-role="harm-note"]');
    if (!out) return;
    const res = harmonizeText(raw, findings, {
      mode: settings.harmonizeMode,
      levels: settings.harmonizeLevels,
      variantIndex: harmVariant,
    });
    harmText = res.text;

    // 零宽字符不可见，用 ␣ 可视化展示，并标出同音替换的字
    let display = escapeHtml(revealZeroWidth(res.text)).replace(/␣/g, '<i class="bsc-zw">␣</i>');
    out.innerHTML = display || '（无可处理内容）';

    const zw = countZeroWidth(res.text);
    const subs = res.changes.filter((c) => !c.visuallyIdentical);
    const parts = [];
    if (subs.length) {
      parts.push(`同音替换 ${subs.length} 处：` + subs.map((c) => `${escapeHtml(c.original)}→${escapeHtml(c.replaced)}`).join('、'));
    }
    if (zw) parts.push(`插入 ${zw} 个零宽字符（␣ 处，实际不可见，复制后保留）`);
    note.innerHTML = parts.join('<br>') || '无变化';
  };

  if (settings.enableHarmonize && findings.length) renderHarmonized();

  el.addEventListener('change', async (e) => {
    if (e.target.name === 'bsc-mode') {
      settings.harmonizeMode = e.target.value;
      await send('SET_SETTINGS', { harmonizeMode: e.target.value });
      harmVariant = 0;
      renderHarmonized();
    }
  });

  el.addEventListener('click', async (e) => {
    const act = e.target.getAttribute?.('data-act');
    if (act === 'close') closePanel();
    if (act === 'copy') { await navigator.clipboard.writeText(rewrite); e.target.textContent = '已复制'; }
    if (act === 'apply') {
      const composer = anchor.__bscComposer;
      if (composer) applyText(composer, rewrite);
      closePanel();
    }
    if (act === 'harm-refresh') { harmVariant++; renderHarmonized(); }
    if (act === 'harm-copy') {
      await navigator.clipboard.writeText(harmText);
      e.target.textContent = '已复制';
      setTimeout(() => (e.target.textContent = '复制'), 2000);
    }
    if (act === 'harm-apply') {
      const composer = anchor.__bscComposer;
      if (composer) applyText(composer, harmText);
      closePanel();
    }
  });
  panelEl = el;
  setTimeout(() => document.addEventListener('click', onOutside, { once: true }), 0);
}

function onOutside(e) {
  if (panelEl && !panelEl.contains(e.target) && !e.target.closest?.('.bsc-btn')) closePanel();
}

function applyText(composer, text) {
  const ed = composer.editor;
  if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') {
    const setter = Object.getOwnPropertyDescriptor(ed.constructor.prototype, 'value')?.set;
    setter ? setter.call(ed, text) : (ed.value = text);
    ed.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    const inner = ed.shadowRoot?.querySelector('[contenteditable]') || ed;
    inner.innerText = text;
    inner.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  }
}

/* ---------------- 按钮注入 ---------------- */
async function runCheck(btn, composer) {
  btn.dataset.state = 'checking';
  btn.querySelector('.bsc-btn-text').textContent = '检测中…';
  try {
    const raw = readEditorText(composer.editor, composer.container).trim();
    const result = detect(raw, { whitelist: settings.whitelist });

    let imageResults = [];
    if (settings.enableImage) {
      const imgs = readEditorImages(composer.container);
      imageResults = await Promise.all(imgs.map((i) => analyzeImage(i).catch(() => ({ findings: [] }))));
      const imgLevel = imageResults.some((r) => r.level === 'high') ? 'high'
        : imageResults.some((r) => r.level === 'mid') ? 'mid' : null;
      if (imgLevel === 'high') result.level = 'high';
      else if (imgLevel === 'mid' && result.level === 'safe') result.level = 'mid';
    }

    btn.dataset.state = result.level === 'safe' ? 'safe' : result.level === 'low' ? 'mid' : result.level;
    btn.querySelector('.bsc-btn-text').textContent =
      result.level === 'safe' ? '未见风险' : `${result.findings.length} 处风险`;
    showPanel(btn, result, raw, imageResults);
  } catch (e) {
    btn.dataset.state = '';
    btn.querySelector('.bsc-btn-text').textContent = '检测失败';
    console.warn('[BSC]', e);
  }
  setTimeout(() => {
    if (btn.dataset.state !== 'checking') {
      btn.dataset.state = '';
      btn.querySelector('.bsc-btn-text').textContent = '敏感性检测';
    }
  }, 6000);
}

function injectButtons() {
  for (const composer of findComposers()) {
    if (composer.sendBtn.parentElement?.querySelector('[data-bsc="btn"]')) continue;
    if (composer.sendBtn.getAttribute('data-bsc-bound')) continue;
    composer.sendBtn.setAttribute('data-bsc-bound', '1');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'bsc-btn';
    btn.setAttribute('data-bsc', 'btn');
    btn.innerHTML = '<span class="bsc-btn-dot"></span><span class="bsc-btn-text">敏感性检测</span>';
    btn.__bscComposer = composer;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); runCheck(btn, composer); });

    // 插到发送按钮前面；shadow DOM 内需把样式一并注入
    const parent = composer.sendBtn.parentElement;
    if (!parent) continue;
    parent.classList.add('bsc-send-anchor');
    parent.insertBefore(btn, composer.sendBtn);
    const root = btn.getRootNode();
    if (root instanceof ShadowRoot) injectStyleInto(root);
  }
}

let cssText = '';
const BADGE_CSS = `
  :host { position: relative !important; }
  .bsc-has-badge { position: relative !important; }
  #more { position: relative !important; z-index: 5 !important; pointer-events: auto !important; }
  bili-comment-menu { z-index: 999 !important; }
  .bsc-has-badge > .bsc-badge,
  .bsc-badge {
    position: absolute !important;
    right: 56px !important;
    bottom: 4px !important;
    z-index: 2 !important;
    display: inline-flex !important;
    align-items: center !important;
    gap: 4px !important;
    box-sizing: border-box !important;
    height: 24px !important;
    min-width: 0 !important;
    padding: 0 8px !important;
    border-radius: 4px !important;
    font-size: 11px !important;
    line-height: 22px !important;
    white-space: nowrap !important;
    vertical-align: middle !important;
    cursor: pointer !important;
    user-select: none !important;
    border: 1px solid #00aeec !important;
    background: #00aeec !important;
    color: #fff !important;
    font-family: inherit !important;
    transform: none !important;
    transition: opacity .15s, background .15s !important;
  }
  .bsc-badge:hover { filter: brightness(.92) !important; }
  .bsc-badge[data-v="checking"] { cursor: progress !important; opacity: .85 !important; }
  .bsc-badge[data-v="idle"] { opacity: .75 !important; }
  .bsc-badge[data-v="self_only"] { background: #e03a3a !important; border-color: #e03a3a !important; }
  .bsc-badge[data-v="folded"] { background: #f08c00 !important; border-color: #f08c00 !important; }
  .bsc-badge[data-v="unknown"] { background: #6c757d !important; border-color: #6c757d !important; }
`;

function injectStyleInto(root) {
  if (!root) return;
  const existing = root.querySelector('style[data-bsc="style"]');
  if (existing) {
    if (cssText && existing.textContent !== cssText) existing.textContent = cssText;
    return;
  }
  const s = document.createElement('style');
  s.setAttribute('data-bsc', 'style');
  s.textContent = cssText || BADGE_CSS;
  root.appendChild(s);
}

/* ---------------- 可见性徽标（懒加载） ----------------
 * 只有当评论真正滚动进视口时才开始检测该条，避免一次性为整页评论排队请求。
 * 徽标渲染在评论右侧。 */

const badged = new WeakSet();
// 刚发送评论的官方核验结果同步到评论卡片，不只显示右下角弹窗。
const knownVisibility = new Map();
const cachedRepliesMap = new Map(); // "mid:cleanText" -> rpid
const cachedRootsMap = new Map();   // rpid -> root

const badgeIO = (typeof IntersectionObserver !== 'undefined')
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        badgeIO.unobserve(e.target);
        const run = e.target.__bscRun;
        if (run) { delete e.target.__bscRun; run(); }
      }
    }, { rootMargin: '0px', threshold: 0.01 })
  : null;

const BADGE_TEXT = {
  checking: '检测可见性 [检测中…]',
  visible:  '检测可见性 [其他人可见]',
  self_only:'检测可见性 [其他人不可见]',
  folded:   '检测可见性 [评论被折叠]',
  unknown:  '检测可见性 [无法确定]',
  idle:     '检测可见性 [待检测]',
};

function setBadge(badge, status, extra) {
  badge.dataset.v = status;
  badge.textContent = BADGE_TEXT[status] || BADGE_TEXT.unknown;
  badge.title = {
    checking: '正在比对游客视角…',
    visible:  '游客视角下可以看到这条评论',
    self_only:'本人可见，但游客视角看不到 —— 很可能已被屏蔽或删除',
    folded:   '评论被折叠，他人需展开才能看到',
    unknown:  extra || '分页较深或接口受限，未能判定',
    idle:     '滚动到此评论时会自动检测',
  }[status] || '';
}

function attachVisibilityBadges() {
  if (!settings.enableVisibility || !myUid) return;
  const ctx = pageCtx;

  for (const c of findMyComments(myUid)) {
    // 寻找挂载宿主容器（优先挂载到操作栏所在的容器内部）
    const shadow = c.el.shadowRoot;
    let host = null;
    if (shadow) {
      host = shadow.querySelector('#footer')
        || shadow.querySelector('#main')
        || shadow.querySelector('#content')
        || shadow;
    } else {
      host = c.el.querySelector?.('.reply-info, .sub-reply-info, .info') || c.el;
    }

    if (!host) continue;
    // 宿主容器内已存在徽标时跳过，防止重绘产生重复按钮
    if (host.querySelector?.('.bsc-badge')) continue;
    badged.add(c.el);

    const badge = document.createElement('button');
    badge.type = 'button';
    badge.className = 'bsc-badge';
    badge.setAttribute('data-bsc', 'badge');
    const cachedV = c.rpid && knownVisibility.get(String(c.rpid));
    if (cachedV) setBadge(badge, cachedV);
    else setBadge(badge, 'idle');

    // 不挂载在头像或用户信息上，统一挂在操作行/内容主容器的右侧（不覆盖 #more 三点菜单）
    host.classList?.add('bsc-has-badge');
    c.el.classList?.add('bsc-has-badge');
    const moreBtn = host.querySelector?.('#more') || shadow?.querySelector?.('#more');
    if (moreBtn && moreBtn.parentNode === host) {
      host.insertBefore(badge, moreBtn);
    } else {
      host.appendChild(badge);
    }

    const root = badge.getRootNode();
    if (root instanceof ShadowRoot) injectStyleInto(root);
    injectStyleInto(document.head || document.documentElement);

    const run = async () => {
      // 页面自身已经明确标记折叠时，无需请求接口。
      const localMark = `${c.el.className || ''} ${c.el.textContent || ''}`;
      if (/已折叠|被折叠|folded|collapsed/i.test(localMark)) {
        setBadge(badge, 'folded');
        return;
      }
      if (!ctx.oid && pageCtx.oid) {
        ctx.oid = pageCtx.oid;
        ctx.type = pageCtx.type;
      }
      if (!ctx.oid && pageCtx.bvid) {
        const rr = await send('RESOLVE_OID', { bvid: pageCtx.bvid });
        if (rr?.ok && rr.data?.oid) {
          pageCtx = rr.data;
          ctx.oid = rr.data.oid;
          ctx.type = rr.data.type;
        }
      }
      if (!ctx.oid) {
        setBadge(badge, 'unknown', '暂时无法解析当前评论区 ID');
        return;
      }
      setBadge(badge, 'checking');
      // 1. 若 DOM 属性未读出 rpid，先查拦截器捕获的本地评论缓存
      if (!c.rpid) {
        const cleanT = String(c.text || '').replace(/\s+/g, '').trim().toLowerCase();
        if (cleanT && myUid) {
          const directMatch = cachedRepliesMap.get(`${myUid}:${cleanT}`);
          if (directMatch) c.rpid = directMatch;
          else {
            for (const [k, rpidVal] of cachedRepliesMap.entries()) {
              if (k.startsWith(`${myUid}:`)) {
                const m = k.slice(String(myUid).length + 1);
                if (cleanT.includes(m) || m.includes(cleanT)) {
                  c.rpid = rpidVal;
                  break;
                }
              }
            }
          }
        }
      }

      // 2. 本地仍未命定时，按 UID+正文+root 走后台只读列表回查
      if (!c.rpid) {
        const rr = await send('RESOLVE_RPID', { oid: ctx.oid, type: ctx.type, text: c.text, root: c.root });
        if (rr?.ok && rr.data?.rpid) c.rpid = String(rr.data.rpid);
        else {
          setBadge(badge, 'unknown', rr?.error || '未能从评论列表解析评论 ID');
          return;
        }
      }

      const rootRpid = c.root || (c.rpid && cachedRootsMap.get(String(c.rpid)));
      const resp = await send('CHECK_VISIBILITY', { oid: ctx.oid, type: ctx.type, rpid: c.rpid, root: rootRpid });
      const status = resp?.data?.status || 'unknown';
      setBadge(badge, status, resp?.data?.error ? `检测未完成：${resp.data.error}` : undefined);
    };

    // 每条自己的评论都提供手动复查按钮；阻止点击冒泡到评论详情。
    badge.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation(); run();
    });

    // 动态懒加载：仅当评论进入视野可见区域时才触发检测，未进入视口的评论保持 idle 待检测态
    if (badgeIO) {
      c.el.__bscRun = run;
      badgeIO.observe(c.el);
    } else {
      run();
    }
  }
}

/* ---------------- 官方判定结果的呈现 ---------------- */

// verdict -> 展示文案。全部基于官方接口的客观回执，不含本地推测。
const VERDICT_VIEW = {
  rejected:  { tone: 'bad',  title: '官方拒绝发送',   desc: 'B站判定该评论包含敏感信息，评论未发出。' },
  blocked:   { tone: 'warn', title: '未能发出',       desc: '受验证码 / 黑名单 / 评论区状态限制，评论未发出。' },
  shadowban: { tone: 'bad',  title: '疑似仅自己可见', desc: '评论已发出，但以游客身份查询不到 —— 即他人很可能看不到。' },
  deleted:   { tone: 'bad',  title: '评论已被删除',   desc: '评论发出后已不在评论区中。' },
  visible:   { tone: 'good', title: '他人可见',       desc: '以游客身份可查询到这条评论，显示正常。' },
  pending:   { tone: 'warn', title: '审核中',         desc: '暂时查询不到，可能仍在审核。稍后可在评论右侧徽标复查。' },
  unknown:   { tone: 'warn', title: '暂无法判定',     desc: '接口未返回明确信息，请稍后手动复查。' },
};

let toastEl = null;
/**
 * 右下角浮层展示官方核验结果。
 * @param {object} opt  {state:'waiting'|'result', verdict, codeLabel, desc}
 */
function showVerdictToast(opt) {
  injectStyleInto(document.head || document.documentElement);
  if (toastEl) { toastEl.remove(); toastEl = null; }

  const el = document.createElement('div');
  el.className = 'bsc-toast';
  let inner;

  if (opt.state === 'waiting') {
    inner = `<div class="bsc-toast-head"><b>正在核验这条评论…</b><span class="bsc-toast-close">✕</span></div>
      <div>已捕获官方回执，${Math.round((settings.verifyWaitMs || 8000) / 1000)} 秒后用只读接口确认他人是否可见。</div>`;
  } else {
    const v = VERDICT_VIEW[opt.verdict] || VERDICT_VIEW.unknown;
    el.classList.add(`bsc-toast-${v.tone}`);
    inner = `<div class="bsc-toast-head"><b>${v.title}</b><span class="bsc-toast-close">✕</span></div>
      <div>${v.desc}</div>
      ${opt.codeLabel ? `<div style="margin-top:4px;color:#9499a0;">官方返回：${opt.codeLabel}</div>` : ''}`;
  }

  el.innerHTML = `${inner}<div style="margin-top:6px;color:#9499a0;font-size:11px;">官方判定核验 · 零写入，未额外发送任何评论</div>`;
  el.querySelector('.bsc-toast-close').addEventListener('click', () => el.remove());
  document.body.appendChild(el);
  toastEl = el;

  const ttl = opt.state === 'waiting' ? 60000 : 15000;
  setTimeout(() => { if (el.isConnected) el.remove(); if (toastEl === el) toastEl = null; }, ttl);
}

/* ---------------- 被动拦截器 ---------------- */

/** 注入页面世界脚本（Firefox 无 MAIN world，需手动注入） */
function ensureInterceptorInjected() {
  if (document.documentElement.dataset.bscHook === '1') return;
  document.documentElement.dataset.bscHook = '1';
  try {
    const s = document.createElement('script');
    s.src = api.runtime.getURL('intercept.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  } catch (e) { console.warn('[BSC] inject interceptor failed', e); }
}

/** 监听页面世界回传的官方回执 */
function listenInterceptor() {
  window.addEventListener('message', async (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.__bas !== true) return;

    if (d.type === 'REPLIES_CACHED') {
      for (const r of d.replies || []) {
        if (r.rpid) {
          const clean = String(r.message || '').replace(/\s+/g, '').trim().toLowerCase();
          if (clean && r.mid) cachedRepliesMap.set(`${r.mid}:${clean}`, String(r.rpid));
          if (r.root) cachedRootsMap.set(String(r.rpid), String(r.root));
        }
      }
      return;
    }

    if (d.type === 'REPLY_SENT') {
      if (!settings.enableVerify) return;

      // 发送失败：返回码已经是最终结果，不做可见性请求。
      if (Number(d.code) !== 0 || !d.rpid) {
        const j = await send('JUDGE_REPLY', {
          code: Number(d.code), apiMessage: d.apiMessage, rpid: d.rpid,
          oid: d.oid, type: Number(d.rtype), root: d.root,
        });
        showVerdictToast({ state: 'result', verdict: j?.data?.verdict || 'unknown', codeLabel: j?.data?.codeLabel });
        return;
      }

      // 发送成功：只调用一次 JUDGE_REPLY，并传入完整上下文。
      // 旧逻辑先用缺少 oid/type 的 JUDGE_REPLY 核验，常会得到 unknown 并提前 return。
      showVerdictToast({ state: 'waiting' });
      const r = await send('JUDGE_REPLY', {
        code: 0, rpid: String(d.rpid), oid: String(d.oid || ''),
        type: Number(d.rtype), root: d.root ? String(d.root) : undefined,
      }, (settings.verifyWaitMs || 8000) + 20000);
      const finalVerdict = r?.data?.verdict || 'unknown';
      const cardStatus = { visible: 'visible', shadowban: 'self_only', pending: 'unknown', unknown: 'unknown' }[finalVerdict];
      if (d.rpid && cardStatus) knownVisibility.set(String(d.rpid), cardStatus);
      showVerdictToast({ state: 'result', verdict: finalVerdict, codeLabel: r?.data?.codeLabel });
      // 新评论节点通常在回执之后才插入 DOM，分阶段补挂卡片按钮。
      setTimeout(attachVisibilityBadges, 300);
      setTimeout(attachVisibilityBadges, 1500);
    }
  });
}

/* ---------------- 启动 ---------------- */
async function init() {
  const pageType = detectPageType();
  if (pageType === 'other') return;

  // 1. 立即注入拦截器并建立通信，抢在任何评论网络请求或组件初始化之前
  ensureInterceptorInjected();
  listenInterceptor();

  // 2. 初始快速解析页面上下文
  pageCtx = resolveOidType();

  const tick = () => { injectButtons(); attachVisibilityBadges(); };

  // 3. 并行并发加载配置、自身信息与规则资源，互不阻塞
  const initPromises = [
    send('GET_SETTINGS').then((st) => { if (st?.ok) settings = { ...settings, ...st.data }; }),
    send('GET_ME').then((me) => {
      if (me?.ok && me.data?.mid) {
        myUid = me.data.mid;
        tick(); // 获得 UID 后立即执行一次挂载，无需等待其他静态资源
      }
    }),
    fetch(api.runtime.getURL('src/content/panel.css'))
      .then((r) => r.text())
      .then((t) => { cssText = t; })
      .catch((e) => { console.warn('[BSC] load css failed', e); }),
    loadRules(api.runtime.getURL('rules/rules.json')).catch(() => {}),
    loadHomophones(api.runtime.getURL('rules/homophones.json')).catch((e) => {
      console.warn('[BSC] load homophones failed; harmonize disabled', e);
      settings.enableHarmonize = false;
    }),
  ];

  if (!pageCtx.oid && pageCtx.bvid) {
    send('RESOLVE_OID', { bvid: pageCtx.bvid }).then((rr) => {
      if (rr?.ok && rr.data?.oid) {
        pageCtx = rr.data;
        tick();
      }
    }).catch(() => {});
  }

  // 首次快速挂载
  tick();

  await Promise.allSettled(initPromises);
  tick();

  // 4. 监听动态载入（下拉加载、展开回复等），降低防抖延迟至 200ms
  let timer = null;
  const scheduleTick = (delay = 200) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, delay);
  };

  new MutationObserver(() => {
    scheduleTick(200);
  }).observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('scroll', () => { scheduleTick(200); }, { passive: true });
}

init().catch((e) => console.warn('[BSC] init failed', e));



