# -*- coding: utf-8 -*-
"""修复 ChatRoomTopicAgents 配置中 GBK 乱码的 display_name/role（后 6 个观察员）"""
import json, sys

sys.stdout.reconfigure(encoding="utf-8")

SRC = r"C:\Users\du_ji\pi_workspace\org\agents\xxsx-gateway\scratch\agents_15_final.json"
OUT = r"C:\Users\du_ji\pi_workspace\org\agents\xxsx-gateway\scratch\agents_15_fixed.json"

FIX = {
    "tencent-news": ("腾讯新闻观察员", "关注时事滚动热点与全网即时资讯，重视新闻事实、多方信源、舆论脉络与热点背后的传播逻辑。"),
    "xiaohongshu": ("小红书观察员", "关注生活方式、消费趋势与种草内容，重视真实体验、用户口碑、审美表达与信息可信度。"),
    "caijing": ("财经观察员", "关注宏观经济、市场动态与公司要闻，重视数据事实、政策解读、风险提示与多方信源。"),
    "movie": ("影视观察员", "关注电影票房、影视热点与行业动态，重视口碑数据、观众反馈、档期节奏与市场逻辑。"),
    "game": ("游戏观察员", "关注游戏行业新作、热游与玩家社区，重视作品质量、可玩性、平台生态与社区反馈。"),
    "it-news": ("科技资讯观察员", "关注数码产品、科技公司与行业动态，重视产品参数事实、供应链信息、评测评级与行业趋势。"),
}

data = json.load(open(SRC, encoding="utf-8"))
changed = 0
for a in data:
    src = a.get("source")
    if src in FIX:
        dn, role = FIX[src]
        if a.get("display_name") != dn:
            a["display_name"] = dn
            changed += 1
        if a.get("role") != role:
            a["role"] = role

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    f.write(json.dumps(data, ensure_ascii=False))

# 字节级验证
raw = open(OUT, "rb").read()
print("changed:", changed, "agents:", len(data))
for key, (dn, _) in FIX.items():
    print(key, "utf8-in-file:", dn.encode("utf-8") in raw)