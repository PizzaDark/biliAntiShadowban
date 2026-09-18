

import { readFileSync } from 'node:fs';
globalThis.fetch = async (u) => ({ json: async () => JSON.parse(readFileSync(String(u),'utf8')), text: async()=>'' });
const { loadRules, detect } = await import('./src/core/detector.js');
const { loadHomophones, harmonizeText, harmonizeSegment, revealZeroWidth, countZeroWidth } = await import('./src/core/harmonize.js');
await loadRules('rules/rules.json');
await loadHomophones('rules/homophones.json');

console.log('=== 需求验证：你好 → 泥豪 / 零宽插入 ===');
console.log('同音字  :', harmonizeSegment('你好','homophone'));
const zw = harmonizeSegment('你好','zerowidth');
console.log('零宽    :', JSON.stringify(zw), '可视化:', revealZeroWidth(zw), '| 长度', [...'你好'].length, '->', [...zw].length);
console.log('视觉相同:', zw.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g,'') === '你好' ? '✓' : '✗');

console.log('\n=== 对检测命中做和谐 ===');
for (const t of ['你就是个傻逼，滚出去','加微信 13812345678','你是不是傻，这都不懂']) {
  const f = detect(t,{whitelist:[]}).findings;
  for (const mode of ['homophone','zerowidth','mixed']) {
    const r = harmonizeText(t, f, { mode });
    const clean = r.text.replace(/[\u200b\u200c\u200d\u2060\ufeff]/g,'');
    console.log(`[${mode.padEnd(9)}] ${revealZeroWidth(r.text)}`);
    if (mode==='zerowidth') console.log(`             还原后与原文一致: ${clean===t?'✓':'✗'}`);
  }
  console.log();
}

console.log('=== 隐私类强制走零宽（同音替换号码无意义） ===');
const f = detect('加微信 13812345678',{whitelist:[]}).findings;
const r = harmonizeText('加微信 13812345678', f, { mode:'homophone' });
console.log(r.changes.map(c=>`${c.original} -[${c.mode}]-> ${revealZeroWidth(c.replaced)}`).join('\n'));

console.log('\n=== 换一批：variantIndex 产生不同结果 ===');
const ff = detect('你就是个傻逼',{whitelist:[]}).findings;
for (let i=0;i<3;i++) console.log(` variant ${i}:`, harmonizeText('你就是个傻逼', ff, {mode:'homophone', variantIndex:i}).text);

console.log('\n=== 和谐后能否骗过自家检测器（验证有效性） ===');
for (const t of ['你就是个傻逼','煞笔up主']) {
  const f0 = detect(t,{whitelist:[]});
  const h = harmonizeText(t, f0.findings, {mode:'homophone'}).text;
  const f1 = detect(h,{whitelist:[]});
  console.log(` "${t}" [${f0.level}] -> "${h}" [${f1.level}] 命中 ${f0.findings.length} -> ${f1.findings.length}`);
}
const zt = harmonizeText('你就是个傻逼', detect('你就是个傻逼',{whitelist:[]}).findings, {mode:'zerowidth'}).text;
console.log(` 零宽版重新检测: 命中 ${detect(zt,{whitelist:[]}).findings.length} 处 (归一化会剥离零宽，本工具仍能识别 = 预期行为)`);



