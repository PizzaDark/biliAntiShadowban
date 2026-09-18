

/**
 * detector.js —— 本地检测引擎
 * 输出结构统一为 Finding[]，每条包含在「原文」中的精确字符区间，便于高亮到具体的字。
 */

import { normalize, mapRange } from './normalize.js';
import { AhoCorasick } from './ac.js';

let RULES = null;
let AC = null;
let COMPILED_REGEX = [];

export async function loadRules(rulesUrl) {
  const res = await fetch(rulesUrl);
  RULES = await res.json();
  AC = new AhoCorasick();
  for (const [cat, words] of Object.entries(RULES.keywords || {})) {
    for (const w of words) {
      const { text } = normalize(w);
      if (text) AC.add(text, { cat, origin: w });
    }
  }
  AC.build();
  COMPILED_REGEX = [...(RULES.regex || []), ...(RULES.softPatterns || [])].map((r) => ({
    ...r,
    re: new RegExp(r.pattern, 'gi'),
  }));
  return RULES;
}

export function getRules() {
  return RULES;
}

/** 允许用户自定义白名单（例如自己的昵称含敏感字） */
function inWhitelist(word, whitelist) {
  return (whitelist || []).some((w) => w && word.includes(w));
}

/**
 * @param {string} raw 用户原始输入
 * @param {{whitelist?: string[]}} opts
 * @returns {{score:number, level:string, findings:Array, visibilityRisk:string}}
 */
export function detect(raw, opts = {}) {
  if (!RULES) throw new Error('规则未加载');
  const findings = [];
  const { text, map } = normalize(raw);

  // 1. 关键词（归一化后匹配，抗拆字/同形绕过）
  for (const hit of AC.search(text)) {
    if (inWhitelist(hit.payload.origin, opts.whitelist)) continue;
    const meta = RULES.categories[hit.payload.cat];
    const range = mapRange(map, hit.start, hit.end, raw.length);
    findings.push({
      type: 'keyword',
      category: hit.payload.cat,
      categoryLabel: meta.label,
      level: meta.level,
      start: range.start,
      end: range.end,
      matched: raw.slice(range.start, range.end),
      message: `命中${meta.label}词「${hit.payload.origin}」`,
      advice: meta.advice,
    });
  }

  // 2. 正则（在原文上跑，位置天然精确）
  for (const r of COMPILED_REGEX) {
    r.re.lastIndex = 0;
    let m;
    while ((m = r.re.exec(raw)) !== null) {
      if (m[0] === '') { r.re.lastIndex++; continue; }
      const meta = RULES.categories[r.category];
      findings.push({
        type: 'pattern',
        ruleId: r.id,
        category: r.category,
        categoryLabel: meta.label,
        level: meta.level,
        start: m.index,
        end: m.index + m[0].length,
        matched: m[0],
        message: r.message,
        advice: r.advice,
      });
      if (findings.length > 200) break;
    }
  }

  // 3. 结构性启发式：全大写吼叫、超长、感叹号轰炸
  if (raw.length > 0) {
    const run = raw.match(/[!！]{5,}/);
    if (run) {
      const start = run.index;
      findings.push({
        type: 'heuristic', category: 'unfriendly', categoryLabel: '不友善', level: 'low',
        start, end: start + run[0].length, matched: run[0],
        message: `连续 ${run[0].length} 个感叹号，语气过激`,
        advice: '减少感叹号，避免被识别为情绪化攻击。',
      });
    }
  }

  // 去重：区间重叠时只保留「级别最高、其次范围最大」的一条，避免同一段文字重复报警
  const rank = { high: 3, mid: 2, low: 1 };
  const ordered = [...findings].sort((a, b) => {
    if (rank[b.level] !== rank[a.level]) return rank[b.level] - rank[a.level];
    return (b.end - b.start) - (a.end - a.start);
  });
  const kept = [];
  for (const f of ordered) {
    if (kept.some((k) => f.start < k.end && k.start < f.end)) continue;
    kept.push(f);
  }
  const list = kept.sort((a, b) => a.start - b.start);

  const score = list.reduce((s, f) => s + ({ high: 40, mid: 15, low: 5 }[f.level] || 0), 0);
  const level = score >= 40 ? 'high' : score >= 15 ? 'mid' : score > 0 ? 'low' : 'safe';
  const visibilityRisk = {
    high: '极可能被屏蔽（仅自己可见）',
    mid: '存在被折叠或限流风险',
    low: '风险较低，但建议微调',
    safe: '未发现明显风险',
  }[level];

  return { score, level, findings: list, visibilityRisk, length: raw.length };
}

/** 生成「建议修改后」的文本：高危整段删除，中低危打码提示 */
export function suggestRewrite(raw, findings) {
  let out = raw;
  const sorted = [...findings].sort((a, b) => b.start - a.start);
  for (const f of sorted) {
    if (f.level === 'high') out = out.slice(0, f.start) + out.slice(f.end);
    else if (f.level === 'mid') out = out.slice(0, f.start) + '*'.repeat(f.end - f.start) + out.slice(f.end);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}



