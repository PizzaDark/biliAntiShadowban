

const api = globalThis.browser ?? globalThis.chrome;
const send = (type, payload) => new Promise((r) => api.runtime.sendMessage({ type, payload }, (x) => r(x || {})));

const $ = (id) => document.getElementById(id);

/** 未确认风险时，锁死和谐处理的所有控件 */
function syncHarmLock() {
  const ack = $('harmAck').checked;
  ['harm', 'harmMode', 'harmLevels'].forEach((id) => {
    $(id).disabled = !ack;
    $(id).closest('.row').style.opacity = ack ? '1' : '.45';
  });
  if (!ack) $('harm').checked = false;
}

async function load() {
  const s = await send('GET_SETTINGS');
  if (!s.ok) return;
  const d = s.data;
  $('vis').checked = d.enableVisibility !== false;
  $('img').checked = d.enableImage !== false;
  $('whitelist').value = (d.whitelist || []).join('\n');
  $('harmAck').checked = d.harmonizeAck !== false;
  $('harm').checked = d.enableHarmonize !== false && d.harmonizeAck !== false;
  $('harmMode').value = d.harmonizeMode || 'mixed';
  $('harmLevels').value = (d.harmonizeLevels || ['high', 'mid', 'low']).join(',');
  syncHarmLock();
  $('verify').checked = d.enableVerify !== false;
  $('verifyWait').value = String(d.verifyWaitMs || 8000);
}

$('save').addEventListener('click', async () => {
  await send('SET_SETTINGS', {
    enableVisibility: $('vis').checked,
    enableImage: $('img').checked,
    whitelist: $('whitelist').value.split('\n').map((s) => s.trim()).filter(Boolean),
    harmonizeAck: $('harmAck').checked,
    enableHarmonize: $('harmAck').checked && $('harm').checked,
    harmonizeMode: $('harmMode').value,
    harmonizeLevels: $('harmLevels').value.split(','),
    enableVerify: $('verify').checked,
    verifyWaitMs: +$('verifyWait').value,
  });
  const tip = $('saved');
  tip.textContent = '已保存，刷新B站页面后生效';
  setTimeout(() => (tip.textContent = ''), 3000);
});

$('harmAck').addEventListener('change', async () => {
  syncHarmLock();
  await send('SET_SETTINGS', {
    harmonizeAck: $('harmAck').checked,
    enableHarmonize: $('harmAck').checked && $('harm').checked,
  });
});

$('vis').addEventListener('change', (e) => send('SET_SETTINGS', { enableVisibility: e.target.checked }));
$('img').addEventListener('change', (e) => send('SET_SETTINGS', { enableImage: e.target.checked }));
$('harm').addEventListener('change', (e) => send('SET_SETTINGS', { enableHarmonize: e.target.checked }));
$('harmMode').addEventListener('change', (e) => send('SET_SETTINGS', { harmonizeMode: e.target.value }));
$('harmLevels').addEventListener('change', (e) => send('SET_SETTINGS', { harmonizeLevels: e.target.value.split(',') }));

$('verify').addEventListener('change', (e) => send('SET_SETTINGS', { enableVerify: e.target.checked }));
$('verifyWait').addEventListener('change', (e) => send('SET_SETTINGS', { verifyWaitMs: +e.target.value }));

if (location.hash === '#welcome') $('legal').scrollIntoView({ behavior: 'smooth' });
load();



