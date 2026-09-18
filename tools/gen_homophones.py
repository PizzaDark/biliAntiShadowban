

#!/usr/bin/env python3
"""
离线生成同音字替换表 rules/homophones.json

思路：
  1) 收集 rules.json 词库中出现的全部汉字（只有这些字才需要被和谐）
  2) 用 pypinyin 取其读音（含声调）
  3) 在「常用汉字表」中找同音字作为候选，按「同音同调 > 同音异调」排序
  4) 过滤掉候选本身也在敏感词库里的字，避免换了个字还是敏感词
  5) 人工优先表（HAND_PICKED）覆盖高频词，保证「你好→泥豪」这类替换观感自然
"""
import json
import os
from collections import defaultdict
from pypinyin import pinyin, Style

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 常用汉字池：候选替换字只能从这里选，避免生僻字
COMMON = (
    "的一是了我不人在他有这个上们来到时大地为子中你说生国年着"
    "就那和要她出也得里后自以会家可下而过天去能对小多然于心学"
    "么之都好看起发当没成只如事把还用第样道想作种开美总从无情"
    "己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老"
    "因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感"
    "见明问力理尔点文几定本公特做外孩相西果走将月十实向声车全"
    "信重三机工物气每并别真打太新比才便夫再书部水像眼等体却加"
    "电主界门利海受听表德少克代员许稜先口由死安写性马光白或住"
    "难望教命花结乐色更拉东神记处让母父应直字场平报友关放至张"
    "认接告入笑内英军候民岁往何度山觉路带万男边风解叫任金快原"
    "吃妈变通师立象数四失满战远格士音轻目条呢病始达深完今提求"
    "清王化空业思切怎非找片罗钱吗语元喜曾离飞科言干流欢约各即"
    "指合反题必该论交终林请医晚制球决窗况苦除风究似官格建维标"
    "泥豪傻沙煞比笔屁批皮脾啤疲奇骑棋旗期欺妻凄戚泣器汽弃企岂"
    "咖喱蛤蟆呆呸嘿嘻哈嗨咦哇喔噢嗯哼呵嘲讽刺激烈猛勇敢弱强壮"
    "菜菊局橘桔聚举巨拒距惧俱剧句锯具距鞠鞠躬弓工功攻宫恭供贡"
    "朋鹏篷蓬碰捧膨烹嘭噗扑铺仆葡莆蒲谱普浦溥曝瀑爆报抱暴豹"
    "脑恼挠闹瑙孬淖残蚕惨灿仓苍舱藏脏葬赃驴旅履屡缕虑滤绿律"
    "蠢春纯唇醇淳椿蹲炖顿盾钝遁墩敦吨囤沌屯豚臀退腿褪吞屯"
    "滚棍辊鲧衮混昆坤困捆昏婚魂浑荤混豁活火伙货获祸霍嚯"
    "杂砸咋咂扎渣札闸眨栅诈榨炸乍摘窄债寨斋宅择泽责则贼怎增"
    "贱剑建健涧溅渐践键舰见件间坚尖肩艰兼监减剪检简"
    "废费肥非飞菲匪诽吠肺沸佛否缝凤奉俸封峰锋疯蜂逢"
    "滚蛋淡弹但担单胆旦氮惮啖诞掸郸眈耽箪澹倒到道盗稻导"
    "微威薇维唯惟围违伟伪尾委未位味畏胃谓喂慰卫为魏"
    "刷耍衰摔甩帅拴闩涮双霜爽水睡税说硕烁朔搜艘擞嗽苏"
)
COMMON = "".join(dict.fromkeys(COMMON))

# 人工挑选：观感最自然的高频替换（优先于自动生成）
HAND_PICKED = {
    "你": ["泥", "尼", "拟"],
    "好": ["豪", "嚎", "郝"],
    "傻": ["沙", "纱", "啥"],
    "逼": ["比", "笔", "鼻"],
    "煞": ["沙", "杀"],
    "笔": ["比", "币"],
    "死": ["4", "斯", "撕"],
    "妈": ["麻", "马", "吗"],
    "滚": ["棍", "辊"],
    "蠢": ["春", "纯"],
    "猪": ["朱", "珠", "株"],
    "狗": ["苟", "构", "购"],
    "垃": ["拉", "啦"],
    "圾": ["鸡", "机", "基"],
    "脑": ["恼", "瑙"],
    "残": ["蚕", "惭"],
    "智": ["志", "制", "至"],
    "障": ["帐", "涨", "丈"],
    "弱": ["若", "偌"],
    "废": ["费", "肺"],
    "物": ["务", "误", "雾"],
    "贱": ["剑", "建", "见"],
    "婊": ["表", "裱"],
    "操": ["糙", "草", "槽"],
    "干": ["赶", "杆", "敢"],
    "屌": ["吊", "掉"],
    "屎": ["史", "使", "始"],
    "尿": ["鸟", "料"],
    "畜": ["处", "触"],
    "生": ["牲", "声", "升"],
    "杂": ["砸", "咋"],
    "种": ["肿", "众", "重"],
    "恶": ["饿", "俄", "鳄"],
    "心": ["新", "辛", "欣"],
    "喷": ["盆", "捧"],
    "子": ["籽", "紫", "仔"],
    "键": ["建", "见", "剑"],
    "侠": ["瞎", "虾", "霞"],
    "急": ["기", "级", "极"],
    "破": ["坡", "泼", "婆"],
    "防": ["房", "妨", "方"],
}
# 清掉误入的非中文
HAND_PICKED["急"] = ["级", "极", "疾"]


def tone_pinyin(ch):
    r = pinyin(ch, style=Style.TONE3, heteronym=False, errors="ignore")
    return r[0][0] if r else None


def plain_pinyin(ch):
    r = pinyin(ch, style=Style.NORMAL, heteronym=False, errors="ignore")
    return r[0][0] if r else None


def main():
    rules = json.load(open(os.path.join(ROOT, "rules", "rules.json"), encoding="utf-8"))

    # 词库中出现的所有汉字 + 词库中的完整词（用于过滤候选）
    chars = set()
    sensitive_chars = set()
    for words in rules.get("keywords", {}).values():
        for w in words:
            for c in w:
                if "\u4e00" <= c <= "\u9fff":
                    chars.add(c)
                    sensitive_chars.add(c)
    # 常用礼貌词也支持和谐（用户可能想和谐任意文本，如「你好」）
    chars |= set(COMMON[:400])

    # 建立 拼音 -> 常用字 索引
    by_tone = defaultdict(list)
    by_plain = defaultdict(list)
    for c in COMMON:
        t, p = tone_pinyin(c), plain_pinyin(c)
        if not t:
            continue
        by_tone[t].append(c)
        by_plain[p].append(c)

    table = {}
    for c in sorted(chars):
        cands = []
        # 1. 人工表优先
        for h in HAND_PICKED.get(c, []):
            if h != c and h not in cands:
                cands.append(h)
        # 2. 同音同调
        t, p = tone_pinyin(c), plain_pinyin(c)
        for h in by_tone.get(t, []):
            if h != c and h not in cands and h not in sensitive_chars:
                cands.append(h)
        # 3. 同音异调
        for h in by_plain.get(p, []):
            if h != c and h not in cands and h not in sensitive_chars:
                cands.append(h)
        if cands:
            table[c] = cands[:5]

    out = {
        "version": rules.get("version"),
        "note": "离线生成的同音字候选表，供和谐功能使用；由 tools/gen_homophones.py 生成，勿手改",
        "map": table,
    }
    path = os.path.join(ROOT, "rules", "homophones.json")
    json.dump(out, open(path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print(f"生成 {len(table)} 个字的同音候选 -> rules/homophones.json")
    for probe in "你好傻逼":
        print(f"  {probe} -> {table.get(probe)}")


if __name__ == "__main__":
    main()



