# 前端运行时证据摘要

- 生成时间：2026-10-20T12:45:56.839Z
- 运行环境：Node v24.11.1 / Python 3.14 / 本机 Chrome headless
- 结论：全部检查通过（70/70）
- 测试：exit 0; 35 passed, 0 failed
- 截图：14 张（见下方清单）

## HTTP / 契约 / CSV / 分享

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 真实后端在空闲端口启动并响应 | 通过 | {"port":49762} |
| GET /api/v1/catalog 返回 200 | 通过 | {"status":200} |
| 目录家具条目 ≥ 9 | 通过 | {"count":12} |
| 目录材质条目 ≥ 6 | 通过 | {"count":8} |
| 目录材质含地面与墙面 kind | 通过 | {"kinds":["floor","wall"]} |
| POST /auth/register 创建账号 | 通过 | {"status":201,"requestId":"f8d3ba43b972e2c6330152c75278ec93"} |
| POST /auth/login 返回 200 | 通过 | {"status":200,"requestId":"202539e0aa4711478ae175b743e4001e"} |
| 登录后获得 kj_session 与 kj_csrf Cookie | 通过 | {"cookies":["kj_session","kj_csrf"]} |
| GET /auth/me 返回当前账号 | 通过 | {"status":200} |
| GET /api/v1/sample 返回 200 且含 doc | 通过 | {"status":200} |
| 样板方案为 4000×3000 + 4000×3000（12.00 + 9.00 m²） | 通过 | {"walls":7,"rooms":2} |
| POST /plans 创建方案 | 通过 | {"status":201,"planId":1,"revision":1,"requestId":"28450edcc7fa41a6dcfbc16592b118ff"} |
| 新方案 revision = 1 | 通过 | {"revision":1} |
| 服务端统计 totalAreaM2 = 21.00 | 通过 | {"stats":{"rooms":[{"roomId":"r1","roomName":"客厅","areaM2":12,"perimeterM":14,"wallAreaM2":33.32,"furnitureCount":4,"floorMaterial":"floor-oak","wallMaterial":"paint-warm-white"},{"roomId":"r2","roomName":"卧室","areaM2":9,"perimeterM":12,"wallAreaM2":30.03,"fur |
| 服务端统计房间 2 个、家具 7 件 | 通过 | {"stats":{"rooms":[{"roomId":"r1","roomName":"客厅","areaM2":12,"perimeterM":14,"wallAreaM2":33.32,"furnitureCount":4,"floorMaterial":"floor-oak","wallMaterial":"paint-warm-white"},{"roomId":"r2","roomName":"卧室","areaM2":9,"perimeterM":12,"wallAreaM2":30.03,"fur |
| GET /plans 列表包含新方案 | 通过 | {"status":200,"total":1} |
| GET /plans/{id} 返回同一份 doc 与统计 | 通过 | {"status":200,"revision":1} |
| PUT /plans/{id} 以 expectedRevision=1 保存成功 | 通过 | {"status":200,"revision":2,"requestId":"a832639c0a658b625cf7597f0549bf5f"} |
| 旧 expectedRevision 触发 409 CONFLICT_REVISION | 通过 | {"status":409,"code":"CONFLICT_REVISION","requestId":"dce595060f72a10875988ee0702e631a"} |
| 409 错误体携带 requestId | 通过 | {"headerRequestId":"dce595060f72a10875988ee0702e631a","bodyRequestId":"dce595060f72a10875988ee0702e631a"} |
| owner CSV 返回 200 与 text/csv | 通过 | {"status":200,"contentType":"text/csv; charset=utf-8"} |
| CSV 含 UTF-8 BOM | 通过 | {"firstCode":65279} |
| CSV 使用 CRLF 行尾 | 通过 | {} |
| CSV 含 12.00 与 9.00 两个房间面积 | 通过 | {} |
| POST /plans/{id}/share 返回 token 与相对 url | 通过 | {"status":201,"url":"/share/x2GF_DyxWg-fz8jwN66VsPduB4kuuMSPsOVL9M7aXR0","tokenLength":43} |
| 公开 GET /share/{token} 返回只读方案 | 通过 | {"status":200,"readOnly":true,"revision":2} |
| 公开分享 CSV 返回 200/BOM/CRLF/12.00 | 通过 | {"status":200} |
| 分享路由拒绝写方法（405/404） | 通过 | {"status":405,"code":"METHOD_NOT_ALLOWED"} |
| 无效分享 token 返回 404 NOT_FOUND | 通过 | {"status":404,"code":"NOT_FOUND","requestId":"af67de7a50a817aba33aabde77428f42"} |
| 未登录 GET /plans 返回 401 AUTH_REQUIRED | 通过 | {"status":401,"code":"AUTH_REQUIRED","requestId":"42b81e2d57f6ff5a477409b6a22e0ed5"} |
| 不存在的方案返回 404 NOT_FOUND | 通过 | {"status":404,"code":"NOT_FOUND","requestId":"1f0e8c61515e583628d808c9d9cdbed1"} |
| GET / 返回应用壳 index.html | 通过 | {"status":200,"contentType":"text/html; charset=utf-8"} |
| CSP 为同源脚本、无 unsafe-eval | 通过 | {"csp":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"} |
| 静态 HTML 带 nosniff | 通过 | {"value":"nosniff, nosniff"} |
| GET /js/app.js 返回 JS | 通过 | {"status":200,"contentType":"text/javascript; charset=utf-8"} |
| GET /vendor/three/three.module.js 返回 200 | 通过 | {"status":200,"bytes":1272950} |
| 内置 Three.js 附 MIT LICENSE | 通过 | {"status":200} |
| 375px 登录页无横向溢出 | 通过 | {"scrollWidth":375,"clientWidth":375,"cardWidth":351} |
| 375px 有数据方案列表无横向溢出 | 通过 | {"scrollWidth":375,"clientWidth":375,"cardCount":1} |
| 列表页关键文本对比度 ≥ 4.5:1 | 通过 | {"measured":[{"selector":".plan-card-meta","ratio":6.58},{"selector":".list-subheading","ratio":5.98},{"selector":".badge","ratio":5.61},{"selector":".button-primary","ratio":7.4},{"selector":".user-chip-name","ratio":13.52},{"selector":".state-text","missing" |
| 2D 画布 aria-label 与文档计数一致（7 墙/4 门窗/7 家具/2 房间） | 通过 | {"editor2dLabel":"2D 户型画布（可编辑）：7 面墙，4 个门窗，7 件家具，2 个房间。"} |
| Delete 键删除选中墙体（墙 7→6） | 通过 | {"before":7,"after":6} |
| Ctrl+Z 撤销恢复整份结构（墙 7、门窗 4、房间 2） | 通过 | {"walls":7,"openings":4,"furniture":7,"rooms":2,"dirty":"未保存","undoDisabled":true,"redoDisabled":false} |
| Ctrl+Shift+Z 重做删除（墙 6） | 通过 | {"walls":6,"openings":3,"furniture":7,"rooms":1,"dirty":"未保存","undoDisabled":false,"redoDisabled":true} |
| 再次撤销回到 7 墙并保持未保存 | 通过 | {"walls":7,"openings":4,"furniture":7,"rooms":2,"dirty":"未保存","undoDisabled":true,"redoDisabled":false} |
| UI 保存后服务端 revision 由 2 增至 3 | 通过 | {"revision":3} |
| 键盘 Tab 后焦点可见（:focus-visible + 可见 outline） | 通过 | {"tag":"A","text":"跳到主要内容","focusVisible":true,"outlineStyle":"auto","outlineWidth":"1px","outlineColor":"rgb(16, 16, 16)"} |
| 3D 画布 aria-label 同源计数（7 墙/2 房间/7 家具） | 通过 | {"label":"3D 视图（轨道）：7 面墙，2 个房间，7 件家具。轨道：拖拽旋转，滚轮缩放，Shift 或右键拖拽平移；第一人称：点击画面锁定鼠标，WASD 移动。","badge":"同一份文档 · 3D","width":1056,"height":589} |
| 3D 视图标记“同一份文档 · 3D” | 通过 | {"badge":"同一份文档 · 3D"} |
| 375px 编辑页无横向溢出 | 通过 | {"scrollWidth":375,"clientWidth":375,"shellWidth":351,"sidebarCollapsed":"false"} |
| 分享页 2D 同源计数（7 墙/4 门窗/7 家具/2 房间） | 通过 | {"share2dLabel":"2D 户型画布（只读查看）：7 面墙，4 个门窗，7 件家具，2 个房间。"} |
| 分享页只读：无编辑入口、标记只读 | 通过 | {"hasEditor":false,"badge":"只读分享","note":"这是只读分享：可以查看 2D/3D 与下载 CSV，不能修改方案。分享令牌撤销后，此链接立即失效。","editButtons":[]} |
| 分享页 3D 同源计数（7 墙/2 房间/7 家具） | 通过 | {"share3dLabel":"3D 视图（轨道）：7 面墙，2 个房间，7 件家具。轨道：拖拽旋转，滚轮缩放，Shift 或右键拖拽平移；第一人称：点击画面锁定鼠标，WASD 移动。"} |
| 无效分享链接展示错误码与 requestId | 通过 | {"title":"分享链接无效","text":"该分享链接无效或已被撤销。","meta":"错误码 NOT_FOUND · requestId ec2e0181a19c11f2061094a3d84e15a7"} |
| 创建第二个空账号 | 通过 | {"status":201} |
| 空账号列表展示空态与新建/样板入口 | 通过 | {"title":"还没有方案","text":"新建一个空白方案，或从内置样板间开始体验两间房间。","actions":["新建方案","从样板间新建"]} |
| 不存在方案展示 NOT_FOUND 与 requestId | 通过 | {"text":"方案不存在，或当前账号无权访问。","meta":"错误码 NOT_FOUND · requestId 32a4146cf98869d6eb61ebc51b1c08c7"} |
| 375px 空列表无横向溢出 | 通过 | {"scrollWidth":375} |
| node --test（tests/frontend/*.test.js）全绿 | 通过 | exit 0; 35 passed, 0 failed |

## 截图

- `tests/frontend/evidence/login-desktop.png`
- `tests/frontend/evidence/login-375.png`
- `tests/frontend/evidence/list-desktop.png`
- `tests/frontend/evidence/list-375.png`
- `tests/frontend/evidence/editor-2d-desktop.png`
- `tests/frontend/evidence/shortcuts-desktop.png`
- `tests/frontend/evidence/editor-3d-desktop.png`
- `tests/frontend/evidence/editor-2d-375.png`
- `tests/frontend/evidence/share-2d-desktop.png`
- `tests/frontend/evidence/share-3d-desktop.png`
- `tests/frontend/evidence/share-error-desktop.png`
- `tests/frontend/evidence/list-empty-desktop.png`
- `tests/frontend/evidence/editor-error-404-desktop.png`
- `tests/frontend/evidence/list-empty-375.png`

## 页面控制台

- 未捕获 JS 异常：0 条
- 控制台 error（4 条）：
  - Failed to load resource: the server responded with a status of 401 (Unauthorized) (http://127.0.0.1:49762/api/v1/auth/me)
  - Failed to load resource: the server responded with a status of 404 (Not Found) (http://127.0.0.1:49762/api/v1/share/this-token-is-invalid-000000000000)
  - Failed to load resource: the server responded with a status of 401 (Unauthorized) (http://127.0.0.1:49762/api/v1/auth/me)
  - Failed to load resource: the server responded with a status of 404 (Not Found) (http://127.0.0.1:49762/api/v1/plans/999999)

## 失败项

- 无

## 证据边界

- 本脚本只在启动期间占用空闲端口，finally 中终止 Chrome/Python 进程树并删除临时数据目录，不保留常驻服务。
- 正式验收仍需 backend 在 verification-evidence 步骤统一启动真实服务并汇入 docs/evidence/。
