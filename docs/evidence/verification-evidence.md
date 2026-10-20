# verification-evidence 真实启动与全流程交付证据

- 生成时间：2026-10-20T13:28:45Z
- 流程/步骤：`kujiale-lite-v1` / `verification-evidence`
- 负责角色：backend；质量档位：production（不放宽）
- 本步骤完成 ≠ 客户验收通过；`verification` 由应用自动派 Proof，不由本证据代替。

## 1. 启动命令、地址与环境

```text
python -m app --port 8080
地址: http://127.0.0.1:8080
环境变量: KUJIALE_DATA_DIR=D:\work\项目\酷家乐\data\verification-run-1792502895
```

为避免破坏开发机上已有的 `data/kujiale.db`，本次运行使用隔离数据目录（仍位于 `data/` 下）；启动命令本身与交付要求完全一致，开发库未被删除或修改。

有效配置（不含任何密钥）：

```json
{
  "host": "127.0.0.1",
  "port": 8080,
  "dataDir": "D:\\work\\项目\\酷家乐\\data\\verification-run-1792502895",
  "dbPath": "D:\\work\\项目\\酷家乐\\data\\verification-run-1792502895\\kujiale.db",
  "staticDir": "D:\\work\\项目\\酷家乐\\web",
  "logLevel": "INFO",
  "sessionTtlHours": 168,
  "secureCookie": false
}
```

- 操作系统：Windows-11-10.0.26200-SP0
- Python：3.14.0
- Node：v24.11.1
- 浏览器：Chrome/155.0.8059.81
- 浏览器可执行文件：`C:\Program Files\Google\Chrome\Application\chrome.exe`
- 服务日志：`docs/evidence/verification-server.log`（22033 bytes）
- 启动/监听事件：`docs/evidence/verification-startup-events.txt`（4 行）

### 启动日志摘录

```text
startup ts=2026-10-20T13:28:16.037Z url=- dataDir=D:\work\项目\酷家乐\data\verification-run-1792502895 dbPath=D:\work\项目\酷家乐\data\verification-run-1792502895\kujiale.db staticInstalled=-
listening ts=2026-10-20T13:28:16.049Z url=http://127.0.0.1:8080 dataDir=D:\work\项目\酷家乐\data\verification-run-1792502895 dbPath=- staticInstalled=True
startup ts=2026-10-20T13:28:39.214Z url=- dataDir=D:\work\项目\酷家乐\data\verification-run-1792502895 dbPath=D:\work\项目\酷家乐\data\verification-run-1792502895\kujiale.db staticInstalled=-
listening ts=2026-10-20T13:28:39.222Z url=http://127.0.0.1:8080 dataDir=D:\work\项目\酷家乐\data\verification-run-1792502895 dbPath=- staticInstalled=True
```

## 2. 测试命令与结果

```text
python -m unittest discover -s tests -v
  exit=0 ran=141 result=OK
node --test --test-reporter=spec tests/frontend/catalog-api.test.js tests/frontend/geometry.test.js tests/frontend/store.test.js tests/frontend/undo.test.js
  exit=0 pass=35 fail=0
```

- 后端完整输出：`docs/evidence/verification-test-run.txt`
- 前端完整输出：`docs/evidence/verification-node-test-output.txt`
- 测试汇总：`docs/evidence/verification-test-summary.txt`
- 浏览器逐步检查：`docs/evidence/verification-checks.txt`（正向 19 项 + 重启 3 项，全部 PASS）
- 浏览器控制台（已脱敏）：`docs/evidence/verification-browser-console.txt`
- 重启控制台：`docs/evidence/verification-restart-console.txt`

## 3. 真实浏览器全流程（提案 §5）

本流程由本机 Chrome/Edge headless + CDP 驱动真实页面；没有改 `web/` 或 `tests/frontend/`。

| 步骤 | 结果 / 观测 |
| --- | --- |
| 注册并登录 | 真实 `POST /api/v1/auth/register` + `login`，进入空列表 |
| 新建「演示户型」 | 通过页面「新建方案」对话框创建，默认 4000×3000 mm = 12.00 m² |
| 画第二个连通房间 | 2D 画布点击画 3 面新墙，与新房间共享既有墙，形成 7 墙 / 2 房 |
| 2 门 + 2 窗 | 门/窗工具点击墙体放置，状态栏 4 个门窗 |
| 3 件家具并旋转 | 双人沙发/茶几/双人床各「右转 15°」两次 = 30° |
| 地面/墙面材质 | 客厅 floor-oak + paint-warm-white；卧室 floor-tile-grey + paint-sage |
| 3D 轨道 / 第一人称 | 切换 3D 并执行鼠标拖动轨道；切第一人称并截图 |
| 保存 | `PUT /api/v1/plans/{id}` 成功，revision 1 → 2 |
| 退出重登 + 列表重开 | 重新登录后从列表打开，revision 2，7 墙/4 门窗/3 家具/2 房 |
| 创建只读分享 | 页面分享对话框生成链接；未截图以免持久化 bearer token |
| 未登录分享页 | 清除 Cookie 后打开 `/share/[redacted]`，2D/3D 只读且无编辑按钮 |
| 共享 CSV | 分享页「下载 CSV 清单」下载成功，首字节 `efbbbf`，含 12.00/9.00 |

- 浏览器报告 planId=1，保存后 revision=2。
- 分享 token 长度：43（原始 token 不落盘）。
- 浏览器端 CSV：202 bytes，首 3 字节 `efbbbf`。
- 浏览器检查失败项：无

### 浏览器请求/响应（真实 requestId）

| method | path | status | requestId | durationMs |
| --- | --- | --- | --- | --- |
| GET | `http://127.0.0.1:8080/api/v1/auth/me` | 401 | `d07eee74934720a9b8f11378934ba8db` | 2 |
| POST | `http://127.0.0.1:8080/api/v1/auth/register` | 201 | `763b8a0bccbeb434d2def19c3e1e581f` | 44 |
| POST | `http://127.0.0.1:8080/api/v1/auth/login` | 200 | `a84f816d0a96575183bd8559fe196baf` | 42 |
| GET | `http://127.0.0.1:8080/api/v1/auth/me` | 200 | `8ff51f0d0e31ef542d9538e2d5a031b4` | 2 |
| GET | `http://127.0.0.1:8080/api/v1/plans?page=1&pageSize=20` | 200 | `b2369e39f4c0fedfac50844098ac2747` | 0 |
| POST | `http://127.0.0.1:8080/api/v1/plans` | 201 | `c4abbb078003ee358a21cf87f4cdec9e` | 9 |
| GET | `http://127.0.0.1:8080/api/v1/plans/1` | 200 | `0da57b9f829e3ea62b2d0c1958051258` | 7 |
| GET | `http://127.0.0.1:8080/api/v1/catalog` | 200 | `e86ec7d3e73966623b577fd2e9b9a27d` | 12 |
| GET | `http://127.0.0.1:8080/api/v1/plans/1` | 200 | `732f8382b6f1335ca676678b8252acd4` | 7 |
| PUT | `http://127.0.0.1:8080/api/v1/plans/1` | 200 | `b1ee8ee00248b851c51b60835a9fa0c5` | 14 |
| GET | `http://127.0.0.1:8080/api/v1/plans/1` | 200 | `98e85a1d7fb7cd1b89e0b681cced855a` | 7 |
| POST | `http://127.0.0.1:8080/api/v1/auth/logout` | 204 | `ee68f28489b7022eef561833b68abf3a` | 9 |
| GET | `http://127.0.0.1:8080/api/v1/auth/me` | 401 | `3bb66fc1a087e64b85b23484393f2bc6` | 0 |
| GET | `http://127.0.0.1:8080/api/v1/auth/me` | 401 | `f0f06e636d6b9488c5b9b80d56621285` | 2 |
| GET | `http://127.0.0.1:8080/api/v1/auth/me` | 401 | `5eed061f243111704194db556996826d` | 3 |
| POST | `http://127.0.0.1:8080/api/v1/auth/login` | 200 | `387451c6ae36fab24f9110845a3956c3` | 47 |
| GET | `http://127.0.0.1:8080/api/v1/auth/me` | 200 | `31bc8965d7414d5fe396cf4e5f32467d` | 2 |
| GET | `http://127.0.0.1:8080/api/v1/plans?page=1&pageSize=20` | 200 | `2bb644c5fafa5775b478da87707165b2` | 0 |
| GET | `http://127.0.0.1:8080/api/v1/plans/1` | 200 | `0c32926d7872b2f9552b9727a8ddc148` | 5 |
| GET | `http://127.0.0.1:8080/api/v1/catalog` | 200 | `e86ec7d3e73966623b577fd2e9b9a27d` | 0 |
| POST | `http://127.0.0.1:8080/api/v1/plans/1/share` | 201 | `2444a458e35abbac91f61b9325d86b88` | 9 |
| GET | `http://127.0.0.1:8080/api/v1/share/[redacted]` | 200 | `98fe4298b03b10a708f829d26670057a` | 7 |
| GET | `http://127.0.0.1:8080/api/v1/catalog` | 200 | `e86ec7d3e73966623b577fd2e9b9a27d` | 1 |
| GET | `http://127.0.0.1:8080/api/v1/share/[redacted]/export.csv` | 200 | `e445d6ee20a9f386bf021e3cc08e26ef` | 8 |

完整记录（已脱敏）：`docs/evidence/verification-network.json`。

## 4. 截图清单

| 截图 | 内容 | 文件存在 |
| --- | --- | --- |
| `verification-01-login.png` | 登录/注册入口（真实 8080） | 是 |
| `verification-02-empty-list.png` | 注册后空方案列表 | 是 |
| `verification-03-blank-plan.png` | 新建「演示户型」的默认 12.00 m² 房间 | 是 |
| `verification-04-two-rooms.png` | 画出第二个连通房间（7 墙 / 2 房） | 是 |
| `verification-05-openings.png` | 加入 2 门 + 2 窗 | 是 |
| `verification-06-furniture-materials.png` | 3 件家具（各旋转 30°）与 2 房地面/墙面材质 | 是 |
| `verification-07-3d-orbit.png` | 3D 轨道视角（真实鼠标拖动） | 是 |
| `verification-08-3d-first-person.png` | 3D 第一人称模式 | 是 |
| `verification-09-saved.png` | 保存后 2D 视图（revision 2） | 是 |
| `verification-10-list-after-relogin.png` | 退出重登后的方案列表 | 是 |
| `verification-11-reopened.png` | 从列表重新打开（revision 2） | 是 |
| `verification-12-share-2d.png` | 未登录窗口中的只读分享页 2D | 是 |
| `verification-13-share-3d.png` | 未登录窗口中的只读分享页 3D | 是 |
| `verification-14-restart-reopened.png` | 进程重启后重新登录并打开同一方案 | 是 |

说明：环境无法保证屏幕录制；这里提供真实页面逐步截图，未伪称录屏。

## 5. CSV 样例与人工可核算数字

- owner：`docs/evidence/verification-plan.csv`
- shared（HTTP）：`docs/evidence/verification-share-http.csv`
- shared（浏览器下载）：`docs/evidence/verification-share.csv`

| 房间 | 面积 (m²) | 家具数 | 地面材质 | 地面面积 (m²) | 墙面材质 | 墙面面积 (m²) |
| --- | --- | --- | --- | --- | --- | --- |
| 客厅 | 12.00 | 2 | floor-oak | 12.00 | paint-warm-white | 33.74 |
| 卧室 | 9.00 | 1 | floor-tile-grey | 9.00 | paint-sage | 30.03 |

- 合计面积：21.00 m²（12.00 + 9.00）；家具合计 3。
- 原始字节：202 bytes；首 3 字节 `efbbbf`；BOM=True；CRLF=True。
- owner 与 shared HTTP 字节完全一致；浏览器下载字节也一致（同一次真实服务）。
- 列名固定为 `room_name,area_m2,furniture_count,floor_material,floor_area_m2,wall_material,wall_area_m2`。
- 材质列按服务端真实输出记录为目录 ID（如 `floor-oak`），不是 UI 中文展示名；这是当前冻结契约的实际字段口径。
- 结论：12.00/9.00、家具 2+1=3、四项材质 ID 均可直接从 CSV 人工核算。

## 6. 失败路径（真实 HTTP）

| 检查 | 请求 | 状态 | requestId | 错误码 |
| --- | --- | --- | --- | --- |
| 未登录读取方案 -> 401 | `GET /api/v1/plans/1` | 401 | `3477af23c7c1a8347ff2804c8ac9bf82` | AUTH_REQUIRED |
| 未登录方案列表 -> 401 | `GET /api/v1/plans` | 401 | `6a01935ecf3093c0f39f10d04b4be07b` | AUTH_REQUIRED |
| 非法分享令牌 -> 404 | `GET /api/v1/share/[redacted]` | 404 | `3bd301b119bf9575fda94cd92cb8aa67` | NOT_FOUND |
| owner 登录（证据核对） | `POST /api/v1/auth/login` | 200 | `5088bbcef8baeb919a5cceea719ac21e` | - |
| owner 读取演示户型 | `GET /api/v1/plans/1` | 200 | `fbb9095831c352999b6d38958f6ed735` | - |
| owner CSV 导出 | `GET /api/v1/plans/1/export.csv` | 200 | `e68f71f4b65f4f027ce072de19fcb5d1` | - |
| 匿名只读分享 API | `GET /api/v1/share/[redacted]` | 200 | `2ec999df3c1517605517cda4d8eef4db` | - |
| 匿名分享页 HTML | `GET /share/[redacted]` | 200 | `acef4f46d2d20e85de69537ab55e4e18` | - |
| 匿名共享 CSV | `GET /api/v1/share/[redacted]/export.csv` | 200 | `239ee26ca633118acaf8112b3a1b268a` | - |
| other 用户 注册 | `POST /api/v1/auth/register` | 201 | `0969d043f617585fd2af7f58a57021d0` | - |
| other 用户 登录 | `POST /api/v1/auth/login` | 200 | `e0f90eaa59997b8241b60e009a96b9a4` | - |
| 他人读取方案 -> 404 | `GET /api/v1/plans/1` | 404 | `c36b31e2ae064a7c285d0ab1b218e551` | NOT_FOUND |
| 他人修改方案 -> 404 | `PUT /api/v1/plans/1` | 404 | `e3e52bc32fbf74633e2e869ccce839a1` | NOT_FOUND |
| 旧 revision 保存 -> 409 | `PUT /api/v1/plans/1` | 409 | `0403fe0f540b2e95983350ad0bad1d45` | CONFLICT_REVISION |
| 缺 CSRF 新建 -> 403 | `POST /api/v1/plans` | 403 | `8f539aa5d10b93e03cc04b713ebe9230` | FORBIDDEN |
| 分享 API 写方法 -> 405 | `PUT /api/v1/share/[redacted]` | 405 | `8552462ef0ddfdbd03e79620d792133b` | METHOD_NOT_ALLOWED |

### 服务端日志摘录（401/403/404/405/409/413/422）

```text
ts=2026-10-20T13:28:16.776Z requestId=d07eee74934720a9b8f11378934ba8db route='GET /api/v1/auth/me' status=401 durationMs=1.15 errCode=AUTH_REQUIRED
ts=2026-10-20T13:28:30.619Z requestId=3bb66fc1a087e64b85b23484393f2bc6 route='GET /api/v1/auth/me' status=401 durationMs=1.53 errCode=AUTH_REQUIRED
ts=2026-10-20T13:28:30.622Z requestId=f0f06e636d6b9488c5b9b80d56621285 route='GET /api/v1/auth/me' status=401 durationMs=1.39 errCode=AUTH_REQUIRED
ts=2026-10-20T13:28:30.792Z requestId=5eed061f243111704194db556996826d route='GET /api/v1/auth/me' status=401 durationMs=1.47 errCode=AUTH_REQUIRED
ts=2026-10-20T13:28:38.669Z requestId=3477af23c7c1a8347ff2804c8ac9bf82 route='GET /api/v1/plans/{plan_id}' status=401 durationMs=0.75 errCode=AUTH_REQUIRED
ts=2026-10-20T13:28:38.688Z requestId=6a01935ecf3093c0f39f10d04b4be07b route='GET /api/v1/plans' status=401 durationMs=1.13 errCode=AUTH_REQUIRED
ts=2026-10-20T13:28:38.696Z requestId=3bd301b119bf9575fda94cd92cb8aa67 route='GET /api/v1/share/{token}' status=404 durationMs=7.51 errCode=NOT_FOUND
ts=2026-10-20T13:28:38.989Z requestId=c36b31e2ae064a7c285d0ab1b218e551 route='GET /api/v1/plans/{plan_id}' status=404 durationMs=5.76 errCode=NOT_FOUND
ts=2026-10-20T13:28:38.995Z requestId=e3e52bc32fbf74633e2e869ccce839a1 route='PUT /api/v1/plans/{plan_id}' status=404 durationMs=5.27 errCode=NOT_FOUND
ts=2026-10-20T13:28:39.019Z requestId=0403fe0f540b2e95983350ad0bad1d45 route='PUT /api/v1/plans/{plan_id}' status=409 durationMs=5.86 errCode=CONFLICT_REVISION
ts=2026-10-20T13:28:39.046Z requestId=8f539aa5d10b93e03cc04b713ebe9230 route='POST /api/v1/plans' status=403 durationMs=1.62 errCode=FORBIDDEN
ts=2026-10-20T13:28:39.061Z requestId=8552462ef0ddfdbd03e79620d792133b route='unmatched' status=405 durationMs=0.2 errCode=METHOD_NOT_ALLOWED
ts=2026-10-20T13:28:39.988Z requestId=4e5f6b9e83bf7c9ed7b7481ba6caac17 route='GET /api/v1/auth/me' status=401 durationMs=1.15 errCode=AUTH_REQUIRED
```

完整日志：`docs/evidence/verification-server.log`；摘录：`docs/evidence/verification-error-log-excerpts.txt`。

结论：未登录 401、他人方案 404、非法分享令牌 404、旧 revision 409、缺 CSRF 403、分享 API 写方法 405；错误体 requestId 与响应头一致。

## 7. 重启恢复

- 第一次启动：`python -m app --port 8080`（隔离 data 目录，全新 SQLite）
- 强停退出码：`1`（模拟进程崩溃，不是优雅关闭）
- 第二次启动：同一命令、同一隔离 SQLite 文件

- 重启前 DB：`user_version=1`, `integrity_check=ok`, `journal_mode=wal`, counts={'users': 2, 'sessions': 3, 'plans': 1, 'shares': 1}, bytes=65536
- 重启后 DB：`user_version=1`, `integrity_check=ok`, `journal_mode=wal`, counts={'users': 2, 'sessions': 5, 'plans': 1, 'shares': 1}, bytes=65536
- 重启后 HTTP：方案 revision=2，分享仍只读；浏览器重新登录并从列表打开成功。
- 截图：`docs/evidence/verification-14-restart-reopened.png`。
- 结论：SQLite WAL + `synchronous=FULL` 下，强停后同一方案 revision、2 个房间、4 个门窗、3 件家具、材质与 30° 旋转全部保留。

## 8. 已知限制与风险

- 本环境无屏幕录制输出，使用真实浏览器逐步截图；这是如实说明，不是伪造录屏。
- 分享页的「清单」体现为 CSV 下载按钮，没有单独的 DOM 清单面板；证据按实际 UI 描述为「下载 CSV 清单」。
- 第一人称模式在 headless 下没有真实指针锁定/键盘漫游，只验证模式切换与同一文档渲染；3D 轨道则执行了真实鼠标拖动。
- 单机单人、SQLite 单写者、默认绑定 127.0.0.1 的容量边界不变；3D 为基元级渲染，不是生产级照片级引擎。
- 分享 token 是 bearer 凭证，本证据只保留长度与脱敏路径；如需复现，请重新生成，不要使用历史 token。
- 本步骤完成不等于客户验收；验收/verification 由后续独立环节判定。

## 9. 复现命令

```text
python -m unittest discover -s tests -v
node --test --test-reporter=spec tests/frontend/catalog-api.test.js tests/frontend/geometry.test.js tests/frontend/store.test.js tests/frontend/undo.test.js
python tests/e2e/run_verification.py
```

`run_verification.py` 使用 `data/verification-run-<timestamp>/` 隔离运行库（不删除、不改写开发机已有的 `data/kujiale.db`），以 `python -m app --port 8080` 启动真实 8080、跑完整浏览器流程、执行失败路径、强停重启并重新生成以上截图/CSV/日志。
