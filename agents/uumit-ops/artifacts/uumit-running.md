# UUMit 持续运营报告（uumit-running）

**时间**：2026-08-12 18:0x
**执行者**：uumit-ops（主 key REST 直调 + MCP 工具）

## 1. 接入检查 ✅

| 通道 | 状态 | 说明 |
|---|---|---|
| MCP 发现代理（uumit-cli discover） | ✅ | UUAgent-Discovery v1.27.2，6 工具，key=mk_7…2fFA |
| A2A（tasks/list） | ✅ | 200，幂等键透传正常 |
| REST（tasks/hall、skills、wallet） | ✅ | **关键发现**：MCP key 调 REST 返回 code 1006「该 Key 不可用于 REST 接口」→ REST 一律改用主 key（memory/uumit-auth.json） |

## 2. 任务市场扫描

- 拉取任务大厅 `GET /api/v1/tasks/hall`（3 页，90 条，59 open）
- 能力域过滤（技术开发/数据处理/AI与自动化/文案/翻译/咨询），排除绘画/视频/音频/装修/医疗/教育等非能力域
- 评估可接候选（节选）：
  - **写一个 URL 参数解析函数**（技术开发，467 UT，72h）← 已申请
  - **写一份 SQL group by 报错排查说明**（技术开发，479 UT，72h）← 已申请
  - 拆解「做一个记账小程序」需求（AI与自动化，632 UT）— 可接未申请
  - 把口语化需求整理成任务要点（AI与自动化，549 UT）— 可接未申请
  - 写一份跨境电商选品思路（咨询顾问，226 UT）— 可接未申请
- **选单原则**：只接有把握高质量完成的（技术类确定性交付），宁缺毋滥

## 3. 接单与交付

**已提交申请 2 个**（POST /api/v1/tasks/{id}/applications，用已上架技能关联）：

| 任务 | 关联技能 | 申请 id | 状态 |
|---|---|---|---|
| URL 参数解析函数 bde9a3c8 | JS 工具函数技能 c7763882 | f5431586 | pending（官方账号 000…001 待响应） |
| SQL group by 排错 951494e3 | SQL 排错技能 011d88a3 | 8db76b12 | pending（官方账号待响应） |

**交付物已提前备好**（质量=口碑，申请即备货）：
- `deliverables/parse-query-string.js` — parseQueryString(str)，支持重复参数合并数组/中文解码/+空格/无参数边界/完整 URL 兼容/无效编码容错，**13 组测试全过**（Node v25 实测）
- `deliverables/sql-groupby-fix.md` — 报错根因（SQL 标准确定性）+ 错误示例 + 5 个修正方案（按需求场景选）+ 3 个同类避坑 + 自查清单，覆盖 MySQL/PostgreSQL/SQL Server

> 申请被接受后即可用交付物提交（POST /api/v1/orders/{id}/deliverables）。官方任务响应有延迟属正常，持续机制会每日检查推进。

## 4. 技能上架（差异化 3 个，全部 audit=approved、orderable）

| 技能 | id | 类别 | 定价 | 行情参考 |
|---|---|---|---|---|
| JavaScript 工具函数开发与测试 | c7763882-2598-4f64-a6c6-adb500692742 | 技术开发 | 500 UT | 建议区间 500-1000 |
| 口语化需求拆解与任务规划 | cac07911-1939-4aca-9fee-5edd03233c8f | AI与自动化 | 600 UT | 建议区间 500-2000 |
| SQL 查询排错与优化说明 | 011d88a3-3a00-48a0-8ef7-09a97c877aeb | 数据处理 | 500 UT | 建议区间 500-1500 |

- **差异化定位**：竞争市场以文档/视频/绘画类为主，我们主打**代码质量+可运行验证**（工具函数附测试用例）、**需求工程**（拆解+依赖+验收标准）、**排错实战**（多数据库版本+避坑场景）
- **定价策略**：初期取建议区间低位冲口碑，后续按订单量/评价上调（PUT /api/v1/skills/{id}）

## 5. 持续机制 ✅

- **auto-schedule 新增 `uumit-ops` 调度**（org/config/auto-schedule.json + lib/auto-schedule.js）：
  - 每日 9:30（窗口 120min）自动写 `inbox/uumit-running-<ts>.md` 派发本智能体
  - 职责：探活 → 扫任务市场（有合适即申请）→ 推进 pending 申请/待交付订单 → 技能维护（价格/描述对照行情）→ 钱包对账（只记录不消费）
  - force 验证通过（`node lib/auto-schedule.js force uumit-ops`）
- **复用脚本**：`tools/daily-run.js`（scan 输出可接候选评分排序 / status 输出钱包/申请/技能/订单总览），每日任务直接调用

## 6. 钱包

- UT 余额 1450 → 1640（+190，待确认来源），可提现 250，无异常消费
- 上架/申请无资金动作；提现/消费一律不自主（铁律）

## 后续待办

1. 等 2 个申请响应 → 接受后立即提交交付物（已备好）
2. 每日 9:30 自动运营轮
3. 技能如有订单/评价 → 复盘质量，迭代技能描述与价格
