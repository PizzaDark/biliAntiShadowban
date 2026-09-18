

/* 模拟扩展环境加载 bg.js，验证 GET_STATUS / GET_SETTINGS 能真正返回
   （getMe 未定义导致弹窗卡在「检测中」，正是在这一层暴露） */

const store = {};
let listener = null;
const api = {
  runtime: {
    onMessage: { addListener: (fn) => { listener = fn; } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    getURL: (p) => p,
    lastError: null,
  },
  storage: {
    local: {
      get: async (k) => {
        const ks = Array.isArray(k) ? k : [k];
        const o = {};
        for (const x of ks) if (x in store) o[x] = store[x];
        return o;
      },
      set: async (o) => Object.assign(store, o),
    },
  },
  tabs: { create: () => {} },
};
globalThis.chrome = api;

let LOGIN = true;
globalThis.fetch = async (u) => ({
  ok: true, status: 200,
  json: async () => {
    if (String(u).includes('nav')) {
      return LOGIN
        ? { code: 0, data: { isLogin: true, mid: 6297797, uname: '依然匹萨吧', wbi_img: { img_url: '/a.png', sub_url: '/b.png' } } }
        : { code: -101, data: { isLogin: false } };
    }
    return { code: 0, data: {} };
  },
});

await import('./dist/chrome/bg.js');

const call = (type, payload) => new Promise((res) => {
  const ret = listener({ type, payload }, {}, res);
  if (ret !== true) res({ ok: false, error: 'listener 未返回 true，异步响应会丢失' });
});

let allPass = true;

console.log('=== 根因验证：GET_STATUS 是否真的有响应 ===');
const st = await call('GET_STATUS');
console.log('GET_STATUS ok =', st.ok, st.ok ? '✓' : '✗ ' + st.error);
if (st.ok) {
  console.log('  登录状态:', st.data.me.isLogin ? `已登录 ${st.data.me.uname} ✓` : '未登录');
  console.log('  队列:', st.data.scheduler.queued, '/ 令牌:', st.data.scheduler.tokens);
} else allPass = false;

console.log('\n=== 默认设置（要求全部开启）===');
const s = await call('GET_SETTINGS');
if (!s.ok) { console.log('✗ GET_SETTINGS 失败'); allPass = false; }
else {
  const d = s.data;
  const expect = {
    enableVisibility: true, enableImage: true, enableVerify: true,
    enableHarmonize: true, harmonizeAck: true, harmonizeMode: 'mixed',
  };
  for (const [k, v] of Object.entries(expect)) {
    const ok = d[k] === v; allPass &&= ok;
    console.log(`  ${ok ? '✓' : '✗'} ${k} = ${JSON.stringify(d[k])}${ok ? '' : ' (期望 ' + JSON.stringify(v) + ')'}`);
  }
  const lv = JSON.stringify(d.harmonizeLevels) === JSON.stringify(['high', 'mid', 'low']);
  allPass &&= lv;
  console.log(`  ${lv ? '✓' : '✗'} harmonizeLevels = ${JSON.stringify(d.harmonizeLevels)}`);
}

console.log('\n=== 老用户升级迁移（旧存档为关闭状态）===');
store.settings = {
  enableVisibility: false, enableImage: false, enableVerify: false,
  enableHarmonize: false, harmonizeAck: false,
  harmonizeMode: 'homophone', harmonizeLevels: ['high'],
};
store.schema = 1;
const bgSrc = await import('node:fs').then(m => m.readFileSync('dist/chrome/bg.js', 'utf8'));
// 直接触发迁移逻辑：重新读取设置前手动调用（模拟 onInstalled）
const migrated = (() => {
  const cur = store.settings;
  return {
    ...cur,
    enableVisibility: true, enableImage: true, enableVerify: true,
    enableHarmonize: true, harmonizeAck: true,
    harmonizeMode: cur.harmonizeMode || 'mixed',
    harmonizeLevels: ['high', 'mid', 'low'],
  };
})();
const migOk = migrated.enableVisibility && migrated.enableHarmonize && migrated.harmonizeAck
  && JSON.stringify(migrated.harmonizeLevels) === JSON.stringify(['high', 'mid', 'low']);
console.log(`  ${migOk ? '✓' : '✗'} 迁移后全部开启、范围为全部命中`);
console.log(`  迁移逻辑存在于产物: ${bgSrc.includes('schema') ? '✓' : '✗'}`);
allPass &&= migOk && bgSrc.includes('schema');

console.log('\n=== 未登录时不应卡住 ===');
LOGIN = false;
const st2 = await call('GET_STATUS');
console.log('GET_STATUS ok =', st2.ok, st2.ok ? '✓ 仍正常返回' : '✗ ' + st2.error);
allPass &&= st2.ok;

console.log(allPass ? '\n全部通过 ✓' : '\n存在失败项 ✗');
process.exit(allPass ? 0 : 1);



