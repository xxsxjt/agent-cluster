# 参考：gbrain（garrytan/gbrain，MIT）— Agent 大脑层

> 2026-08-05 学习记录。作者 Garry Tan（YC CEO），生产级：146,646 页/24,585 人/5,339 公司/66 cron。
> 核心理念：**Search gives you raw pages. GBrain gives you the answer.** —— 让 agent 不再失忆。

## 对虚无记忆体系 v2 的蓝图价值（⭐⭐⭐）

### 1. 三层能力
1. **检索层**：hybrid search（向量+BM25+图谱信号）
2. **合成层（synthesis）**：给出"答案"而非"10 个检索块"——带引用 + 明确标注"brain 还不知道什么"（**gap analysis 差距分析**）
3. **自布线知识图谱**：写页面时自动抽取实体引用 + 建 typed edges（works_at/founded/invested_in/attended），**零 LLM 调用**（确定性规则，无模型成本）

### 2. 零 LLM 实体抽取（关键技术，可直接借鉴）
- 单词 tokenizer（字母/连字符/撇号，1-40 长）+ 连续非停用词拼短语
- **高精度优先**：先看检索回的 slug 是否在实体前缀路径（people/companies/orgs/deals/）→ 是则高置信候选
- 其次：问题文本的 noun-phrase 抽取（小写化 + ~200 停用词过滤）
- **每问上限 5 个候选**（防 dilution），5s/调用超时，并发 3
- **隔离通道（quarantine lane）**：自动抽取的实体桩先隔离，人工 promote/reject 审核（doctor 检查：未验证桩超 N 天待审）

### 3. 知识图谱结构（schema 参考）
- 实体页（people/companies/orgs/deals 等规范路径）+ typed edges 表
- 写入时确定性建边（无 LLM 成本），查询"who works at X"走图遍历而非纯向量
- 评测：P@5 49.1%，R@5 97.9%（240 页语料），图谱启用比纯向量 +31.4 分

### 4. 公司大脑（多用户隔离）
- 团队每人一个分片，登录 scope 隔离——查询只见自己有权看的
- fuzz 测试全读取路径零泄漏

### 5. 自动维护
- 每晚 consolidate memory（合并记忆）
- 修正自己的引用（fixes its own citations）
- cron 66 个自主任务

## 虚无落地建议（记忆体系 v2）
1. **先从文件版记忆跑通**（diary/组级/全局，已建），再进化图谱版
2. 借鉴点：
   - 实体抽取的"隔离通道+人工审核"（防止自动抽取污染知识库）
   - "gap analysis"（记忆回答时明确"还不知道什么"）
   - typed edges 零 LLM 建边（确定性规则织网）
   - 分片隔离（用户/组级权限）
3. 暂不引入：复杂 DB（pglite/图谱库），虚无先用文件+JSON 够用

## 学习来源
- https://github.com/garrytan/gbrain（MIT，保留 LICENSE）
- 深挖文件：src/core/think/entity-extract.ts、src/core/search/graph-signals.ts、src/schema.sql
