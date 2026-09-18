

import { readFileSync } from 'node:fs';
globalThis.fetch = async (u) => ({ json: async () => JSON.parse(readFileSync(String(u).replace('file://',''),'utf8')) });
const { loadRules, detect, suggestRewrite } = await import('./src/core/detector.js');
await loadRules('rules/rules.json');

const cases = [
  '这个视频讲得真好，学到了很多，感谢up主！',
  '你就是个傻逼，滚出去',
  '傻 逼 玩意',          // 空格拆字
  '傻\u200b逼',          // 零宽字符
  '煞笔up主',
  '你是不是傻，这都不懂',
  '加微信 13812345678 低价出',
  '看这里 https://example.com/aaa 有资源',
  '哈哈哈哈哈哈哈哈哈哈哈哈',
  '好耶！！！！！！',
  '身份证 11010119900307123X',
];

let pass = 0;
for (const c of cases) {
  const r = detect(c, { whitelist: [] });
  const marks = r.findings.map(f => `[${f.start},${f.end})"${f.matched}"=${f.categoryLabel}/${f.level}`).join(' ');
  // 校验区间确实指向原文的对应字符
  const ok = r.findings.every(f => c.slice(f.start,f.end) === f.matched && f.start>=0 && f.end<=c.length);
  if (ok) pass++;
  console.log(`${ok?'✓':'✗'} [${r.level}] ${JSON.stringify(c)}`);
  if (marks) console.log(`    ${marks}`);
  if (r.findings.length) console.log(`    建议: ${JSON.stringify(suggestRewrite(c, r.findings))}`);
}
console.log(`\n区间精确性: ${pass}/${cases.length}`);



