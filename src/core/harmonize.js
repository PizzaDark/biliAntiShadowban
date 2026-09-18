

/**
 * harmonize.js —— 和谐处理引擎
 *
 * 两种处理方式：
 *   1) homophone  同音字替换：你好 → 泥豪
 *   2) zerowidth  零宽字符插入：你好 → 你\u200b好（视觉完全一致）
 *   3) mixed      混合：对命中片段交替使用上述两种
 *
 * ⚠️ 使用须知（同步展示在 UI 与法律声明中）：
 *   该功能会改变文本以降低被自动识别的概率，属于对内容审核机制的规避。
 *   它不会让违规内容变得合规 —— 平台仍可能通过语义模型、人工审核判定违规，
 *   且「刻意规避审核」本身在多数平台规则下即构成违规，可能加重处罚。
 *   本功能仅供用户在了解上述风险后，对自认为被误判的正常表达自行使用。
 */

let HOMOPHONES = null;

// 可选的零宽字符集合，随机挑选可降低被「固定字符黑名单」一次性清洗的概率
const ZW_CHARS = [
  '\u200b', // ZERO WIDTH SPACE
  '\u200c', // ZERO WIDTH NON-JOINER
  '\u200d', // ZERO WIDTH JOINER
  '\u2060', // WORD JOINER
  '\ufeff', // ZERO WIDTH NO-BREAK SPACE
];

export async function loadHomophones(url) {
  const res = await fetch(url);
  const json = await res.json();
  HOMOPHONES = json.map || {};
  return HOMOPHONES;
}

export function hasHomophone(ch) {
  return !!(HOMOPHONES && HOMOPHONES[ch]);
}

function pickHomophone(ch, seedIdx = 0) {
  const list = HOMOPHONES?.[ch];
  if (!list || !list.length) return null;
  return list[seedIdx % list.length];
}

const randZw = () => ZW_CHARS[Math.floor(Math.random() * ZW_CHARS.length)];

/**
 * 对单个片段做和谐
 * @param {string} seg 片段原文
 * @param {'homophone'|'zerowidth'|'mixed'} mode
 * @param {{variantIndex?:number, zwDensity?:number}} opts
 *        zwDensity: 每个字符之间插入零宽字符的概率(0~1)，默认 1（每字之间都插）
 */
export function harmonizeSegment(seg, mode = 'homophone', opts = {}) {
  const { variantIndex = 0, zwDensity = 1 } = opts;
  const chars = [...seg];

  if (mode === 'zerowidth') {
    // 在字符之间插入零宽字符（首尾不插，避免被 trim 掉）
    return chars
      .map((c, i) => (i < chars.length - 1 && Math.random() <= zwDensity ? c + randZw() : c))
      .join('');
  }

  if (mode === 'homophone') {
    return chars
      .map((c, i) => pickHomophone(c, variantIndex + i) || c)
      .join('');
  }

  // mixed：优先同音字，没有同音候选的字用零宽字符隔开
  return chars
    .map((c, i) => {
      const h = pickHomophone(c, variantIndex + i);
      if (h) return h;
      return i < chars.length - 1 ? c + randZw() : c;
    })
    .join('');
}

/**
 * 依据检测结果，对原文中命中的片段做和谐处理
 * @param {string} raw 原文
 * @param {Array} findings detect() 的结果
 * @param {{mode?:string, levels?:string[], variantIndex?:number, zwDensity?:number}} opts
 *        levels: 只处理这些等级的命中，默认 ['high','mid']
 * @returns {{text:string, changes:Array}}
 */
export function harmonizeText(raw, findings, opts = {}) {
  const {
    mode = 'homophone',
    levels = ['high', 'mid'],
    variantIndex = 0,
    zwDensity = 1,
  } = opts;

  const targets = findings
    .filter((f) => levels.includes(f.level))
    // 正则型的隐私/链接类不适合同音替换（替换后仍是完整号码），零宽更合适
    .map((f) => ({
      ...f,
      useMode: mode === 'homophone' && f.category === 'privacy' ? 'zerowidth' : mode,
    }))
    .sort((a, b) => a.start - b.start);

  if (!targets.length) return { text: raw, changes: [] };

  let out = '';
  let cursor = 0;
  const changes = [];

  targets.forEach((f, idx) => {
    if (f.start < cursor) return; // 重叠跳过
    out += raw.slice(cursor, f.start);
    const original = raw.slice(f.start, f.end);
    const replaced = harmonizeSegment(original, f.useMode, {
      variantIndex: variantIndex + idx,
      zwDensity,
    });
    changes.push({
      start: f.start,
      end: f.end,
      original,
      replaced,
      mode: f.useMode,
      // 零宽处理后视觉不变，给 UI 一个提示标记
      visuallyIdentical: f.useMode === 'zerowidth',
      categoryLabel: f.categoryLabel,
    });
    out += replaced;
    cursor = f.end;
  });
  out += raw.slice(cursor);

  return { text: out, changes };
}

/** 把零宽字符可视化，便于用户确认「到底插了什么」 */
export function revealZeroWidth(text) {
  return text.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, '␣');
}

/** 统计文本中的零宽字符数量 */
export function countZeroWidth(text) {
  return (text.match(/[\u200b\u200c\u200d\u2060\ufeff]/g) || []).length;
}



