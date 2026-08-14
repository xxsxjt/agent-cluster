# CNB 空间1 端到端构建验证（完善补验）— cnb-e2e-build-test-improve

## 结论
✅ **CNB E2E 构建验证全链路通过**（补验完成，2026-08-11 14:32）

## 源任务失败原因分析
- 源任务 `cnb-e2e-build-test`（本机任务 → 路由 CNB → 结果同步回来，真实跑 Gradle 构建）首跑失败。
- 失败标记：`.FAILED: CNB 任务超时（600s）且软超时宽限后远端仍无活动，判定卡死`。
- 根因（据 cnb-task.log）：任务投递到 CNB 空间1 后轮询至 600s 软超时，宽限 10min 后远端日志 mtime=0（停滞）→ 判定真卡死强停。空间实例在期间重启过（旧实例 cnb-jno 已 closed）。

## 补验执行（重跑）
- 环境：CNB 空间1 当前实例 `cnb-77h-1jvno52fu`（running），8核/16G，openjdk 21.0.12，Gradle 8.14.3。
- SSH 桥经 `scripts/cnb-ctl.js ssh 1` 拿最新动态地址，`id_rsa_cnb` 连通。
- 项目：`/data/cnb-org/tasks/e2e-build`（settings.gradle + build.gradle + src/main/java/com/example/Hello.java）。
- 构建方式改为**后台 nohup + 日志轮询**（避免长超时卡死判定，可监控 mtime）。

## 验证证据
| 项目 | 结果 |
|---|---|
| Gradle 构建 | `BUILD SUCCESSFUL`，exit 0 |
| 构建产物 | `build/libs/cnb-e2e-hello.jar`（963B） |
| 产物 manifest | `Main-Class: com.example.Hello` ✅ |
| 运行输出 | `CNB_E2E_BUILD_OK version=1.0`，EXIT=0 |
| 远端 DONE 标记 | `/data/cnb-org/inbox/cnb-e2e-build-test.DONE` ✅ 已写 |

## 经验教训
1. **重跑用后台+日志轮询**：Gradle 首次构建/依赖下载耗时长，用 nohup 后台跑 + 轮询日志（观察 mtime/进度），比前台 600s 硬超时更能避免误判卡死。
2. **jar 名无版本号**：项目无 version 时产物是 `cnb-e2e-hello.jar` 而非通配 `-*.jar`，运行需用确切名。
3. **实例会重启**：CNB 空间实例重启后 SSH 地址/实例 id 会变，必须用 `cnb-ctl` 动态拿最新，不硬编码。
