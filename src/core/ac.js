

/**
 * ac.js —— Aho-Corasick 多模式匹配自动机
 * 词表可达数千条，逐词 indexOf 会造成输入卡顿，这里用 AC 自动机保证 O(n) 扫描。
 */

export class AhoCorasick {
  constructor() {
    this.goto = [new Map()];
    this.fail = [0];
    this.output = [[]];
  }

  add(word, payload) {
    if (!word) return;
    let node = 0;
    for (const ch of word) {
      let next = this.goto[node].get(ch);
      if (next === undefined) {
        next = this.goto.length;
        this.goto.push(new Map());
        this.fail.push(0);
        this.output.push([]);
        this.goto[node].set(ch, next);
      }
      node = next;
    }
    this.output[node].push({ word, len: [...word].length, payload });
  }

  build() {
    const queue = [];
    for (const [, next] of this.goto[0]) {
      this.fail[next] = 0;
      queue.push(next);
    }
    while (queue.length) {
      const node = queue.shift();
      for (const [ch, next] of this.goto[node]) {
        let f = this.fail[node];
        while (f !== 0 && !this.goto[f].has(ch)) f = this.fail[f];
        this.fail[next] = this.goto[f].has(ch) ? this.goto[f].get(ch) : 0;
        if (this.fail[next] === next) this.fail[next] = 0;
        this.output[next] = this.output[next].concat(this.output[this.fail[next]]);
        queue.push(next);
      }
    }
    return this;
  }

  /** @returns {{start:number,end:number,word:string,payload:any}[]} 归一化文本下标 */
  search(text) {
    const hits = [];
    let node = 0;
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      while (node !== 0 && !this.goto[node].has(ch)) node = this.fail[node];
      node = this.goto[node].has(ch) ? this.goto[node].get(ch) : 0;
      for (const o of this.output[node]) {
        hits.push({ start: i - o.len + 1, end: i + 1, word: o.word, payload: o.payload });
      }
    }
    return hits;
  }
}



