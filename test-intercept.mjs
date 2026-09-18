

/* 验证：拦截器零写入、正确旁路读取；judge() 只读 */
import { readFileSync } from 'node:fs';

// ---------- 1. 拦截器：不得发起任何自己的请求 ----------
const issued = [];
const origFetchCalls = [];
globalThis.window = {
  location: { origin: 'https://www.bilibili.com' },
  postMessage: (m) => messages.push(m),
  addEventListener: () => {},
};
const messages = [];
globalThis.location = window.location;
globalThis.Request = class {};
globalThis.FormData = class { entries(){return [];} };
globalThis.XMLHttpRequest = function(){};
globalThis.XMLHttpRequest.prototype = { open(){}, send(){}, addEventListener(){} };
// 页面原始 fetch：记录真实发出的请求
window.fetch = async (u, init) => {
  origFetchCalls.push({ u: String(u), method: (init&&init.method)||'GET' });
  return { clone: () => ({ json: async () => ({ code: 12016, message: '评论内容包含敏感信息' }) }) };
};

const code = readFileSync('dist/chrome/intercept.js','utf8');
new Function('window','location','Request','FormData','XMLHttpRequest', code)(
  window, location, Request, FormData, XMLHttpRequest);

console.log('=== 拦截器行为 ===');
console.log('注入后自发请求数:', origFetchCalls.length, origFetchCalls.length===0?'✓ 零写入':'✗');

// 模拟页面自己发评论
await window.fetch('https://api.bilibili.com/x/v2/reply/add', {
  method:'POST', body:'oid=123&type=1&message=测试内容&csrf=x'
});
await new Promise(r=>setTimeout(r,20));
const sent = messages.filter(m=>m.type==='REPLY_SENT');
console.log('页面发1条评论 -> 实际HTTP请求数:', origFetchCalls.length, origFetchCalls.length===1?'✓ 未放大':'✗');
console.log('捕获到官方响应:', sent.length===1?'✓':'✗');
if(sent[0]) console.log(`  code=${sent[0].code} oid=${sent[0].oid} message="${sent[0].message}"`);
console.log('未捕获用户 csrf:', sent[0] && !JSON.stringify(sent[0]).includes('csrf')?'✓':'✗');

// ---------- 2. judge()：只读 ----------
console.log('\n=== judge() 判定（全部只读）===');
const calls=[];
globalThis.fetch = async (u, init={}) => {
  calls.push({u:String(u).split('?')[0], m:init.method||'GET', c:init.credentials});
  const J=o=>({ok:true,status:200,json:async()=>o});
  if(String(u).includes('nav')) return J({code:0,data:{isLogin:true,wbi_img:{img_url:'/a1.png',sub_url:'/b2.png'}}});
  if(String(u).includes('wbi/main')) return J({code:0,data:{replies:SCENE.guest.map(r=>({rpid:r})),top_replies:[]}});
  if(String(u).includes('/reply/reply')) return J({code:SCENE.alive?0:12006,data:{replies:[]}});
  return J({code:0,data:{}});
};
let SCENE={};
const { Scheduler } = await import('./src/bg/limiter.js');
const { judge } = await import('./src/bg/official.js');
const sched=new Scheduler();

const cases=[
  {n:'官方拒绝 12016', args:{code:12016}, exp:'rejected'},
  {n:'需验证码 12015', args:{code:12015}, exp:'blocked'},
  {n:'游客可见',      args:{code:0,rpid:'9'}, scene:{guest:['9'],alive:true}, exp:'visible'},
  {n:'ShadowBan',     args:{code:0,rpid:'9'}, scene:{guest:[],alive:true},   exp:'shadowban'},
  {n:'被系统删除',    args:{code:0,rpid:'9'}, scene:{guest:[],alive:false},  exp:'deleted'},
];
let pass=0;
for(const c of cases){
  SCENE=c.scene||{guest:[],alive:true}; calls.length=0;
  const r=await judge({oid:'123',type:1,scheduler:sched,waitMs:5,...c.args});
  const ok=r.verdict===c.exp;
  const writes=calls.filter(x=>x.m==='POST');
  const noWrite=writes.length===0;
  pass += (ok&&noWrite)?1:0;
  console.log(`${ok&&noWrite?'✓':'✗'} ${c.n.padEnd(16)} -> ${r.verdict.padEnd(10)} 写操作:${writes.length} ${noWrite?'✓零写入':'✗有写!'}`);
  if(r.codeLabel&&r.code) console.log(`    官方码 ${r.code} ${r.codeLabel}`);
  if(r.detail) console.log(`    ${r.detail}`);
}
console.log(`\n判定: ${pass}/${cases.length} 通过（且全部零写入）`);



