

/**
 * normalize.js
 * 文本归一化：把「变体写法」还原为标准形态，同时保留每个归一化字符 -> 原文索引的映射，
 * 使检测结果能够精确定位到原始输入的第几个字。
 *
 * 处理：全角/半角、大小写、繁简(常用)、同形替换(0->o, 1->i, 拼音缩写不处理)、
 *      零宽字符/emoji 分隔符插入、重复字符拉伸(如「傻~~~逼」)、注音符号。
 */

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/;
// 常见用于「插字规避」的噪声符号
const NOISE = /[\s.\-_*~^`'"!,;:|/\\()\[\]{}<>+=?、。，；：！？·—…“”‘’《》（）【】]/;

// 同形/谐音替换表（键为归一化后的单字符）
const HOMOGLYPH = {
  '０': '0', '１': '1', '２': '2', '３': '3', '４': '4',
  '５': '5', '６': '6', '７': '7', '８': '8', '９': '9',
  'о': 'o', 'О': 'o', 'а': 'a', 'е': 'e', 'р': 'p', 'с': 'c', 'х': 'x',
  'ⅰ': 'i', 'Ⅰ': 'i', 'ǀ': 'l', 'І': 'i',
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
};

// 常用繁体 -> 简体（覆盖敏感词表可能出现的字；完整表体积过大，按需扩充）
const T2S = {
  '個':'个','們':'们','這':'这','會':'会','來':'来','時':'时','國':'国','過':'过','說':'说','麼':'么',
  '話':'话','發':'发','種':'种','點':'点','樣':'样','實':'实','關':'关','間':'间','員':'员','問':'问',
  '權':'权','黨':'党','習':'习','領':'领','導':'导','華':'华','軍':'军','鬥':'斗','爭':'争','動':'动',
  '義':'义','機':'机','網':'网','電':'电','視':'视','幹':'干','媽':'妈','雜':'杂','賤':'贱','驢':'驴',
  '腦':'脑','殘':'残','廢':'废','滾':'滚','閉':'闭','買':'买','賣':'卖','錢':'钱','號':'号','聯':'联',
  '係':'系','應':'应','該':'该','為':'为','與':'与','後':'后','裡':'里',
};

/**
 * @param {string} raw 原始文本
 * @returns {{text: string, map: number[]}} text 为归一化文本，map[i] = text[i] 在 raw 中的索引
 */
export function normalize(raw) {
  const out = [];
  const map = [];
  let prevChar = '';

  for (let i = 0; i < raw.length; i++) {
    let ch = raw[i];

    // 1. 零宽字符 / 变体选择符：直接丢弃（常用于拆字规避）
    if (ZERO_WIDTH.test(ch)) continue;

    // 2. 组合用记号（注音、变音）去掉
    const nfkd = ch.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
    if (nfkd.length >= 1) ch = nfkd[0];

    // 3. 全角 -> 半角
    const code = ch.charCodeAt(0);
    if (code >= 0xff01 && code <= 0xff5e) ch = String.fromCharCode(code - 0xfee0);
    if (code === 0x3000) ch = ' ';

    // 4. 大小写
    ch = ch.toLowerCase();

    // 5. 繁 -> 简
    if (T2S[ch]) ch = T2S[ch];

    // 6. 同形替换
    if (HOMOGLYPH[ch]) ch = HOMOGLYPH[ch];

    // 7. 噪声符号丢弃（保留索引可追溯性：直接不入表）
    if (NOISE.test(ch)) continue;

    // 8. 折叠 3 次以上重复（「傻aaaa逼」→「傻a逼」不误伤正常叠词，仅折叠 >=3）
    if (ch === prevChar && out.length >= 2 && out[out.length - 2] === ch) {
      continue;
    }

    out.push(ch);
    map.push(i);
    prevChar = ch;
  }

  return { text: out.join(''), map };
}

/** 把归一化文本上的 [start, end) 区间还原为原文区间 */
export function mapRange(map, start, end, rawLength) {
  if (!map.length) return { start: 0, end: 0 };
  const s = map[Math.min(start, map.length - 1)];
  const e = end - 1 < map.length ? map[end - 1] + 1 : rawLength;
  return { start: s, end: Math.max(e, s + 1) };
}



