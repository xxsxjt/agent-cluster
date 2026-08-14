# 预告片成片拼接 + 管线评估（2026-08-10）

## 一、成片产出

**`project/final/final_trailer.mp4`** — 17.13s / 1280x720 / 24fps / h264 / 5.7MB

- **输入素材**（scene1/2/3 齐全）：
  - `scene1_720p.mp4`（5.04s，觉醒）— 用 720p 版与 scene2/3 同规格
  - `scene2_fortress.mp4`（6.08s，铁壁城擂台）
  - `scene3_invasion.mp4`（6.06s，幽界入侵）
- **方法**：`extend_video.py chain` 链式拼接 + 尾帧关键帧对齐过渡（每段之间插入上一段尾帧做 0.5s fade in/out，实现视觉衔接）
- **验证**：ffprobe 确认尺寸/fps/时长一致；抽帧确认 fade 转场帧位于 5.3s/11.3s，对齐正常

### 脚本 bug 修复
`extend_video.py` 的 `chain` 拼接 filter_complex 标签构建有误：旧代码把 concat 输入写成 `[v0]..[vN]`，但 ffmpeg 实际用 `[i:v]` 输入索引且过渡帧被 fade 重命名成 `[tr_i]`，导致 concat 引用空标签而失败。已改为按实际输入索引 `[i:v]` + 过渡帧输出 `[tr_i]` 正确拼接。修复后 chain 全链路跑通。

## 二、Agnes 旧管线评估 → 收敛 seedance-video-gen

### 现状
- `project/pipeline.js` 走 Agnes 本地代理（`localhost:3456/3457`，API key `sk-agnes-local-proxy-v1`）
- **已确认不可用**（2026-08-09 踩坑）：本地 Agnes API 3456/3457 已 down，WorkBuddy/agnes 旧路径失效，pipeline.js 无法直接跑
- 已改走 `seedance-video-gen` skill（redfox.hk 封装火山方舟 Seedance 2.0），可用 key `ak_c4fc9018...`（`ak_b45b6a68` 已禁用 3105）

### 评估结论：**废弃 Agnes 旧管线，收敛到 seedance-video-gen**

| 维度 | Agnes pipeline.js | seedance-video-gen |
|------|------------------|--------------------|
| 可用性 | 已 down（3456/3457） | 可用，一行命令出片 |
| 鉴权 | 本地代理 key | redfox 封装 ARK，免白名单 |
| 产出规格 | 1152x768 | 720p/16:9 稳定，seed 可复现 |
| 依赖 | 本地服务/WorkBuddy 路径 | 仅需 HTTP + key |
| 维护 | 无人维护 | skill 化，有脚本 |

### 收敛建议
1. **pipeline.js 标记废弃**（保留作历史参考，不删）：生产路径全部走 seedance-video-gen
2. **关键帧补帧**：若 scene4/5 需出素材，用 `seedance-video-gen` 按 SCRIPT.md 关键帧 prompt 生成，规格对齐 720p/16:9/24fps
3. **可用 key 固化**（沿用上次建议）：写 `~/.qoder/apis/redfox.json`，避免每次翻历史会话
4. **extend_video.py 保留**：作为 scene 拼接/延长的本地 ffmpeg 工具，与 seedance 产出互补（seedance 出片段 → extend_video 拼接成片）

### 后续待办
- scene4/5 素材缺失（本次只拼 scene1/2/3）。如需完整 3min 预告片，需用 seedance-video-gen 补 scene4/5 关键帧并二次拼接。
