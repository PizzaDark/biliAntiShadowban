

const api = globalThis.browser ?? globalThis.chrome;

/** 带超时的消息发送：后台异常时不能让界面永远停在「检测中」 */
const send = (type, payload, timeout = 8000) => new Promise((resolve) => {
  let done = false;
  const timer = setTimeout(() => {
    if (!done) { done = true; resolve({ ok: false, error: '后台无响应（超时）' }); }
  }, timeout);
  try {
    api.runtime.sendMessage({ type, payload }, (r) => {
      if (done) return;
      done = true; clearTimeout(timer);
      if (api.runtime.lastError) return resolve({ ok: false, error: api.runtime.lastError.message });
      resolve(r || { ok: false, error: '后台返回空响应' });
    });
  } catch (e) {
    if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: e.message }); }
  }
});

const $ = (id) => document.getElementById(id);

const TOGGLES = [
  ['vis',    'enableVisibility'],
  ['img',    'enableImage'],
  ['verify', 'enableVerify'],
  ['harm',   'enableHarmonize'],
];

function setPill(el, text, cls) {
  el.textContent = text;
  el.className = `pill${cls ? ' ' + cls : ''}`;
}

async function refresh() {
  const st = await send('GET_STATUS');

  if (!st.ok) {
    // 明确报错，而不是一直「检测中」
    setPill($('login'), '后台异常', 'warn');
    setPill($('queue'), '-', '');
    setPill($('breaker'), '-', '');
    $('quotaNum').textContent = '—';
    $('err').style.display = 'block';
    $('err').textContent = `无法连接后台：${st.error}。请在扩展管理页重新加载本扩展，或重启浏览器。`;
    return;
  }
  $('err').style.display = 'none';

  const { scheduler, me } = st.data;
  if (me?.isLogin) setPill($('login'), `已登录 ${me.uname}`, 'ok');
  else if (me?.error) setPill($('login'), '检测失败', 'warn');
  else setPill($('login'), '未登录', 'warn');

  // 请求额度：说明它是本地节流、免费、自动恢复
  const q = scheduler.quota ?? scheduler.tokens ?? 0;
  const qm = scheduler.quotaMax ?? 5;
  const sec = scheduler.secondsPerRefill ?? 5;
  $('quotaNum').textContent = `${q} / ${qm} 次可用`;
  $('quotaFill').style.width = `${Math.max(0, Math.min(100, (q / qm) * 100))}%`;
  $('quotaNote').innerHTML = q >= qm
    ? '<span class="free-tag">免费</span>额度已满。这是本地限速，用完会自动恢复，无总量上限。'
    : `<span class="free-tag">免费</span>约每 ${sec} 秒自动恢复 1 次，${Math.ceil((qm - q) * sec)} 秒后回满。
       这是本地限速（防止请求过快被B站风控），<b>不是付费额度</b>，可长期使用。`;

  setPill($('queue'), `${scheduler.queued} 条`, scheduler.queued > 0 ? '' : 'ok');
  setPill($('breaker'),
    scheduler.breaker ? `暂停至 ${new Date(scheduler.breakerUntil).toLocaleTimeString()}` : '正常',
    scheduler.breaker ? 'warn' : 'ok');

  const s = await send('GET_SETTINGS');
  if (s.ok) {
    for (const [id, key] of TOGGLES) $(id).checked = s.data[key] !== false;
  }
}

for (const [id, key] of TOGGLES) {
  $(id).addEventListener('change', (e) => send('SET_SETTINGS', { [key]: e.target.checked }));
}

$('opts').addEventListener('click', () =>
  api.tabs.create({ url: api.runtime.getURL('src/ui/options/options.html') }));

refresh();
setInterval(refresh, 3000);



