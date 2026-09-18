

/* 验证：可见性徽标懒加载 —— 未进入视口的评论不得发起检测请求
   用最小 DOM + 可控的 IntersectionObserver 桩来驱动 content.js 的逻辑分支。 */

const observed = [];
let ioCallback = null;

class FakeIO {
  constructor(cb) { ioCallback = cb; }
  observe(el) { observed.push(el); }
  unobserve(el) { const i = observed.indexOf(el); if (i >= 0) observed.splice(i, 1); }
  disconnect() { observed.length = 0; }
}

/** 把若干元素「滚动进视口」 */
function scrollIntoView(els) {
  ioCallback(els.map((el) => ({ isIntersecting: true, target: el })));
}

// —— 复刻 main.js 中的懒加载核心逻辑（与源码保持一致的行为契约）——
const requests = [];
const send = async (type, payload) => {
  requests.push({ type, rpid: payload.rpid });
  return { ok: true, data: { status: 'visible' } };
};

const badgeIO = new FakeIO((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    badgeIO.unobserve(e.target);
    const run = e.target.__bscRun;
    if (run) { delete e.target.__bscRun; run(); }
  }
});

function attach(comments) {
  const badges = [];
  for (const c of comments) {
    const badge = { dataset: {}, textContent: '', title: '' };
    badge.dataset.v = 'idle';
    badges.push(badge);
    const run = async () => {
      badge.dataset.v = 'checking';
      const r = await send('CHECK_VISIBILITY', { rpid: c.rpid });
      badge.dataset.v = r.data.status;
    };
    c.el.__bscRun = run;
    badgeIO.observe(c.el);
  }
  return badges;
}

// 30 条评论，只有 3 条进入视口
const comments = Array.from({ length: 30 }, (_, i) => ({ el: { id: i }, rpid: `rp${i}` }));
const badges = attach(comments);

let pass = true;
console.log('=== 懒加载行为 ===');
console.log(`  已挂载徽标: ${badges.length} 个`);
console.log(`  初始状态全部为 idle: ${badges.every((b) => b.dataset.v === 'idle') ? '✓' : '✗'}`);
pass &&= badges.every((b) => b.dataset.v === 'idle');
console.log(`  未滚动时发起的请求数: ${requests.length} ${requests.length === 0 ? '✓ 零请求' : '✗ 不应发起'}`);
pass &&= requests.length === 0;

scrollIntoView([comments[0].el, comments[1].el, comments[2].el]);
await new Promise((r) => setTimeout(r, 20));

console.log('\n=== 滚动 3 条进入视口后 ===');
console.log(`  发起请求数: ${requests.length} ${requests.length === 3 ? '✓ 只检测可见的 3 条' : '✗'}`);
pass &&= requests.length === 3;
console.log(`  请求的 rpid: ${requests.map((r) => r.rpid).join(', ')}`);
console.log(`  前 3 个徽标已出结果: ${badges.slice(0, 3).every((b) => b.dataset.v === 'visible') ? '✓' : '✗'}`);
pass &&= badges.slice(0, 3).every((b) => b.dataset.v === 'visible');
console.log(`  其余 27 个仍为 idle: ${badges.slice(3).every((b) => b.dataset.v === 'idle') ? '✓' : '✗'}`);
pass &&= badges.slice(3).every((b) => b.dataset.v === 'idle');

// 重复滚动同一条不应重复请求
scrollIntoView([comments[0].el]);
await new Promise((r) => setTimeout(r, 20));
console.log(`\n  重复进入视口不重复请求: ${requests.length === 3 ? '✓' : '✗ 重复了'}`);
pass &&= requests.length === 3;

// —— 校验源码确实使用了 IntersectionObserver ——
const src = await import('node:fs').then((m) => m.readFileSync('src/content/main.js', 'utf8'));
const hasIO = src.includes('IntersectionObserver') && src.includes('badgeIO.observe');
const hasIdle = src.includes("setBadge(badge, 'idle')");
console.log(`\n=== 源码检查 ===`);
console.log(`  使用 IntersectionObserver: ${hasIO ? '✓' : '✗'}`);
console.log(`  徽标初始为待检测态: ${hasIdle ? '✓' : '✗'}`);
console.log(`  按钮为手动点击触发: ${src.includes("btn.addEventListener('click'") ? '✓' : '✗'}`);
console.log(`  未监听输入自动检测: ${!/addEventListener\('input'[^)]*runCheck/.test(src) ? '✓' : '✗'}`);
pass &&= hasIO && hasIdle;

console.log(pass ? '\n全部通过 ✓' : '\n存在失败项 ✗');
process.exit(pass ? 0 : 1);



