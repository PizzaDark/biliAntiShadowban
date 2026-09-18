import { resolveReplyId, checkVisibility, VISIBILITY } from './src/bg/visibility.js';
import { Scheduler } from './src/bg/limiter.js';
import { extractCommentCleanText, findRootRpid } from './src/content/dom.js';

let passed = true;
const scheduler = new Scheduler();

// ---------- 1. resolveReplyId 测试：Cursor 游标深度翻页与模式匹配 ----------
console.log('=== 测试 1: resolveReplyId Cursor 翻页与文本匹配 ===');

// 模拟 B站接口
const mockDb = {
  // mode 2: 最新评论 (Page 1 没有，Page 2 有目标评论)
  mode2_page1: {
    code: 0,
    data: {
      cursor: { pagination_reply: { next_offset: 'cursor_offset_2' }, is_end: false },
      replies: [
        { rpid: '1001', mid: '999', content: { message: '路人甲评论' } },
        { rpid: '1002', mid: '999', content: { message: '路人乙评论' } },
      ],
    },
  },
  mode2_page2: {
    code: 0,
    data: {
      cursor: { pagination_reply: { next_offset: '' }, is_end: true },
      replies: [
        { rpid: '1003', mid: '12345', content: { message: '这是我的真实评论[doge]！' } },
      ],
    },
  },
};

globalThis.fetch = async (url) => {
  const u = String(url);
  const J = (o) => ({ ok: true, status: 200, json: async () => o });
  if (u.includes('wbi/main')) {
    if (u.includes(encodeURIComponent('{"offset":"cursor_offset_2"}')) || u.includes('cursor_offset_2')) {
      return J(mockDb.mode2_page2);
    }
    return J(mockDb.mode2_page1);
  }
  if (u.includes('reply/reply')) {
    return J({
      code: 0,
      data: {
        replies: [
          { rpid: '2001', mid: '12345', content: { message: '楼中楼回复内容' } }
        ]
      }
    });
  }
  if (u.includes('wbi/get-key') || u.includes('nav')) {
    return J({ code: 0, data: { isLogin: true, wbi_img: { img_url: '/a.png', sub_url: '/b.png' } } });
  }
  return J({ code: 0, data: {} });
};

// 测试 1.1: 在第 2 页的评论能够通过游标翻页被找到，且能匹配含有表情符号的 DOM 文本
const foundRpid = await resolveReplyId({
  oid: '111',
  type: 1,
  uid: '12345',
  text: '这是我的真实评论！', // DOM 提取的无表情文本
  scheduler,
  maxPages: 3,
});
console.log('  游标翻页至第 2 页并找到评论 rpid:', foundRpid === '1003' ? '✓ (rpid=1003)' : '✗ ' + foundRpid);
passed &&= foundRpid === '1003';

// 测试 1.2: 楼中楼子评论通过 root 快速命中
const subRpid = await resolveReplyId({
  oid: '111',
  type: 1,
  uid: '12345',
  root: '8888',
  text: '楼中楼回复内容',
  scheduler,
});
console.log('  楼中楼通过 root 精准查找命中:', subRpid === '2001' ? '✓ (rpid=2001)' : '✗ ' + subRpid);
passed &&= subRpid === '2001';

// ---------- 2. checkVisibility 测试：单条高效核验 ----------
console.log('\n=== 测试 2: checkVisibility 单条高效核验 ===');

// 模拟可见 vs Shadowban 场景
let checkScene = 'visible';
globalThis.fetch = async (url, init = {}) => {
  const isGuest = init.credentials === 'omit';
  const J = (o) => ({ ok: true, status: 200, json: async () => o });
  if (String(url).includes('reply/reply')) {
    if (checkScene === 'visible') {
      return J({ code: 0, data: { root: { rpid: '3001' }, replies: [] } });
    }
    if (checkScene === 'shadowban') {
      // 游客视角返回 12006 (评论不存在)，登录视角返回 0 (正常可见)
      return isGuest ? J({ code: 12006, message: '没有该评论' }) : J({ code: 0, data: { root: { rpid: '3002' } } });
    }
  }
  return J({ code: 0, data: {} });
};

checkScene = 'visible';
const visRes = await checkVisibility({ oid: '111', type: 1, rpid: '3001', scheduler });
console.log('  游客可见状态检测:', visRes.status === VISIBILITY.VISIBLE ? '✓ visible' : '✗ ' + visRes.status);
passed &&= visRes.status === VISIBILITY.VISIBLE;

checkScene = 'shadowban';
const sbRes = await checkVisibility({ oid: '111', type: 1, rpid: '3002', scheduler });
console.log('  Shadowban 仅自己可见检测:', sbRes.status === VISIBILITY.SELF_ONLY ? '✓ self_only' : '✗ ' + sbRes.status);
passed &&= sbRes.status === VISIBILITY.SELF_ONLY;

// ---------- 3. DOM 清洗与特征提取 ----------
console.log('\n=== 测试 3: DOM 正文清洗 ===');
// 模拟一个复合卡片节点
const fakeCard = {
  nodeType: 1,
  querySelectorAll: (sel) => {
    if (sel === 'bili-rich-text, #content #contents, .reply-content, .text-con, .con') {
      return [{
        nodeType: 1,
        className: 'reply-content',
        childNodes: [
          { nodeType: 3, textContent: '回复 @张三 : 这是实际的回复正文！' },
          { nodeType: 1, localName: 'img', alt: '[脱出]' },
        ],
      }];
    }
    return [];
  },
};
const cleanMsg = extractCommentCleanText(fakeCard);
console.log('  剥离回复前缀并保留表情:', cleanMsg === '这是实际的回复正文！ [脱出]' ? '✓' : `✗ (${cleanMsg})`);
passed &&= cleanMsg === '这是实际的回复正文！ [脱出]';

console.log(passed ? '\n所有针对性验证全部通过 ✓' : '\n存在失败项 ✗');
process.exit(passed ? 0 : 1);
