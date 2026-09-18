

const { Scheduler } = await import('./src/bg/limiter.js');
const s = new Scheduler();
const t0 = Date.now();
const stamps = [];
// 模拟 8 个标签页同时请求，其中 4 个是重复 key
const tasks = [];
for (let i=0;i<8;i++){
  const key = i<4 ? `dup:${i%2}` : `uniq:${i}`;
  tasks.push(s.schedule(async()=>{ stamps.push(Date.now()-t0); return i; },{key}).catch(e=>'ERR:'+e.message));
}
const res = await Promise.all(tasks);
console.log('实际发出请求次数:', stamps.length, '(8 个调用，重复 key 已合并)');
console.log('各请求相对时间(ms):', stamps);
const gaps = stamps.slice(1).map((t,i)=>t-stamps[i]);
console.log('间隔:', gaps);
console.log('最小间隔 >= 1800ms:', gaps.every(g=>g>=1800) ? '✓ 通过' : '✗ 失败');
console.log('队列状态:', s.state);



