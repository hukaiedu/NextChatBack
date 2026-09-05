# personChat Backend

> 通过 Playwright 驱动 Gemini Web 的 personChat 后端服务。

**本项目不调用 Gemini API。** 后端通过 Playwright 驱动一个持久化 Chromium，在 `gemini.google.com` 页面上以「真人式」输入 / 读取的方式与 Gemini Web 交互，不需要任何 Gemini / Google API Key。

---

## 目录

- [1. 项目简介](#1-项目简介)
- [2. 系统架构](#2-系统架构)
- [3. 核心能力](#3-核心能力)
- [4. 技术栈](#4-技术栈)
- [5. 目录结构](#5-目录结构)
- [6. 环境要求](#6-环境要求)
- [7. 快速开始](#7-快速开始)
- [8. 首次 Gemini 登录](#8-首次-gemini-登录)
- [9. 环境变量](#9-环境变量)
- [10. Provider 状态](#10-provider-状态)
- [11. Request 状态机](#11-request-状态机)
- [12. Scheduler（全局单飞）](#12-scheduler全局单飞)
- [13. SSE 流式推送](#13-sse-流式推送)
- [14. Cancel 取消](#14-cancel-取消)
- [15. Recovery 重启恢复](#15-recovery-重启恢复)
- [16. 数据存储](#16-数据存储)
- [17. API 概览](#17-api-概览)
- [18. 错误码与 HTTP 映射](#18-错误码与-http-映射)
- [19. 开发与测试](#19-开发与测试)
- [20. V1 验收状态](#20-v1-验收状态)
- [21. 已知限制](#21-已知限制)
- [22. 常见问题](#22-常见问题)
- [23. 安全说明](#23-安全说明)
- [24. 相关仓库](#24-相关仓库)

---

## 1. 项目简介

personChat Backend 是 personChat 的服务端。

它负责 Conversation、Message、Request 的持久化，通过 Scheduler 串行调度 Gemini 请求，通过 Playwright 驱动持久化 Chromium 与 Gemini Web 交互，并通过 SSE 向前端推送流式回答。

**SQLite / Prisma 是聊天主数据的权威数据源。** SSE 只是实时推送通道，任何时刻以数据库为准。

**当前定位：**

- 单用户
- 单实例
- 本地使用
- 小规模内网使用

**不适用于：**

- 公网多租户 SaaS
- 多实例横向扩展
- 无人值守的 Google 自动登录

---

## 2. 系统架构

```text
NextChat Frontend
        │
        │ REST / SSE
        ▼
personChat Backend
        │
        ├─ ConversationService
        ├─ MessageService
        ├─ RequestService
        ├─ RequestScheduler
        ├─ SSE
        └─ GeminiPromptService
                │
                ▼
          BrowserManager
                │
                ▼
        Playwright Chromium
                │
                ▼
         gemini.google.com

SQLite / Prisma
    ├─ Conversation
    ├─ Message
    └─ ModelRequest
```

要点：

- **SQLite 是最终权威数据源**；SSE 只是实时推送通道。
- Controller → Service → Scheduler → GeminiPromptService → Adapter 单向组装（见 [src/app.ts](src/app.ts)）。
- Request 状态流转的**唯一入口**是 `RequestService`；Adapter / MessageService / Controller 都不得自行改状态。
- 流式通道单向向外：`RequestService` / `GeminiStreamService` 发布事件，SSE 只订阅读取、从不写库。

---

## 3. 核心能力

当前已实现：

- Conversation 创建 / 查询 / 重命名
- Archive / Restore（`PATCH` 切换 `ACTIVE` ↔ `ARCHIVED`）
- Soft Delete（`DELETE` → `204`，标记 `DELETED`，不可恢复）
- Message 持久化（USER / ASSISTANT，`position` 严格递增）
- Request 状态机（见 [§11](#11-request-状态机)）
- `Idempotency-Key` 幂等（同 Key 同内容命中返回既有记录）
- 同 Conversation 单活跃 Request（数据库 partial unique index 兜底）
- 全局 Gemini 单飞（同一时刻最多 1 个 Request 在 Gemini 上执行）
- Gemini 多轮上下文（复用 `providerConversationUrl` 绑定的同一会话）
- `providerConversationUrl` 绑定（URL 一确定即落库，先于回答读取）
- SSE 流式回答（`delta` 增量）
- SSE 断线重连（重连先给 `snapshot` 全量）
- Cancel（取消生成）
- Cancel 保留已生成的部分回答
- Browser Page Close 与 Crash 区分（`PROVIDER_PAGE_CLOSED` vs `PROVIDER_BROWSER_CRASHED`）
- Chromium / Context Crash 恢复
- 服务重启 Recovery
- SQLite 一致性保护（Request ↔ Assistant 状态配对检查）
- 错误码统一映射（见 [§18](#18-错误码与-http-映射)）
- 日志脱敏（不记 Prompt / 回答原文 / 未脱敏会话 URL）

**以下不是本项目能力，请勿据此使用：**

- 多用户 / 多租户隔离
- 多实例横向扩展
- Gemini API（本项目走浏览器自动化，非 API）
- 自动 Google 登录
- 可靠的 `RATE_LIMITED` 真实检测（仅保留错误码与 HTTP 429 映射）

---

## 4. 技术栈

以下版本以冻结 commit `4dfb074` 的 [package.json](package.json) / [.nvmrc](.nvmrc) 为准：

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | `>=22`（`engines`）；**已验证 24.14.0** | `.nvmrc` 固定 `24.14.0` |
| TypeScript | `5.9.3` | 编译到 `dist/` |
| Express | `5.2.1` | HTTP 服务 |
| Prisma | `7.10.0` | ORM，客户端生成到 `src/generated/prisma` |
| SQLite | 经 `@prisma/adapter-better-sqlite3` `7.10.0` | 权威数据源 |
| Playwright | `1.62.1` | 驱动持久化 Chromium |
| Zod | `^3.24.1` | 入参 / 环境变量校验 |
| Pino | `^9.5.0` | 结构化日志 |
| Vitest | `^2.1.8` | 单元 / 集成测试 |
| Yarn | `1.22.19` | 包管理器（`packageManager` 字段固定） |
| dotenv | `^16.4.5` | 读取 `.env` |
| tsx | `^4.19.2` | 开发模式热重载 |

> Node 最低版本仅在 `package.json` 的 `engines` 中声明为 `>=22`；实际验证使用的是 **Node 24.14.0**。

---

## 5. 目录结构

以实际源码为准（注意是 `src/database/` 而非 `src/db/`）：

```text
src/
├─ common/            # 通用基础设施
│  ├─ errors/         # AppError、错误码、错误码→HTTP 映射
│  ├─ logger/         # Pino 日志封装
│  ├─ middleware/     # requestId、统一错误出口
│  └─ utils/          # 指纹、解析、Prisma 错误识别等
├─ config/            # env.ts（环境变量校验）、constants.ts
├─ database/          # prisma.ts（PrismaClient 创建与探活）
├─ generated/         # prisma generate 产物（客户端，勿手改）
├─ modules/
│  ├─ conversation/   # 会话：controller / service / repository / schema
│  ├─ message/        # 消息：发送、列表、流式内容落库
│  ├─ request/        # 请求：状态机、Scheduler、Recovery、Cancel、一致性
│  ├─ provider/       # Provider API 与 GeminiPromptService / GeminiStreamService
│  ├─ sse/            # SSE：controller / service / 事件总线 / delta 计算
│  └─ health/         # 健康检查
├─ providers/
│  └─ gemini/         # BrowserManager、Playwright driver、Adapter、selectors、session-checker
├─ app.ts             # 组装根：路由挂载与依赖注入
└─ main.ts            # 进程入口：启动顺序与优雅关闭

prisma/               # schema.prisma 与 migrations/
tests/                # unit/ 与 integration/
data/                 # database/（SQLite）、browser-profile/（Chromium profile）
```

---

## 6. 环境要求

- **Node.js**：`>=22`，推荐 `.nvmrc` 固定的 `24.14.0`
- **Yarn**：`1.22.19`（经典版）
- **Playwright Chromium**：需单独安装浏览器二进制（见 [§7.3](#73-安装-chromium)）
- **SQLite**：无需独立服务，Prisma 通过 better-sqlite3 适配器直接读写本地文件
- **可访问 Google / Gemini 的网络环境**：首次登录与后续对话都需要能打开 `gemini.google.com`

---

## 7. 快速开始

### 7.1 Clone

```bash
git clone https://github.com/hukaiedu/NextChatBack.git
cd NextChatBack
```

### 7.2 安装依赖

```bash
yarn install
```

### 7.3 安装 Chromium

Playwright 需要下载浏览器二进制：

```bash
npx playwright install chromium
```

### 7.4 环境变量

复制示例文件为 `.env`：

```text
.env.example  →  .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

Linux / macOS：

```bash
cp .env.example .env
```

`.env.example` 内容（**不含任何真实 Cookie / Token / Google 凭证**）：

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3010
DATABASE_URL="file:./data/database/app.db"
LOG_LEVEL=info
BROWSER_PROFILE_DIR=./data/browser-profile
BROWSER_HEADLESS=false
GEMINI_BASE_URL=https://gemini.google.com/app
GEMINI_RESPONSE_TIMEOUT_MS=300000
REQUEST_EXECUTION_TIMEOUT_MS=600000
STREAMING_UPDATE_INTERVAL_MS=300
```

> `DATABASE_URL` 是唯一**没有默认值**的必填项，缺失会在启动时抛 `VALIDATION_ERROR` 并 fail-fast。

### 7.5 Prisma（生成客户端 + 初始化数据库）

Prisma 7 的配置在 [prisma.config.ts](prisma.config.ts)（schema 路径、migrations 路径、datasource url 均来自此文件与 `DATABASE_URL`）。

生成客户端（`package.json` 中已定义 `prisma:generate` 脚本）：

```bash
yarn prisma:generate
```

应用迁移、创建 / 升级 SQLite 表结构（`package.json` **没有** migrate 脚本，直接用 Prisma CLI）：

```bash
yarn prisma migrate deploy
```

> 迁移文件位于 `prisma/migrations/`（当前 2 个：`init_core_tables`、`phase_2_1_concurrency_guards`）。`migrate deploy` 只应用已有迁移，不会交互式生成新迁移，适合首次初始化与部署。

### 7.6 启动

**开发模式（热重载，直接跑 TS 源码）：**

```bash
yarn dev
```

**生产模式（先编译再运行 `dist`）：**

```bash
yarn build
node dist/main.js
```

> `yarn start` 等价于 `node dist/main.js`（需先 `yarn build`）。所有脚本以 [package.json](package.json) 的 `scripts` 为准：`dev` / `build` / `typecheck` / `start` / `test` / `prisma:generate`。

启动成功后日志会打印：

```text
server listening on http://127.0.0.1:3010
```

默认地址（当前源码 `HOST=127.0.0.1`、`PORT=3010`）：

```text
http://127.0.0.1:3010
```

健康检查：

```bash
curl http://127.0.0.1:3010/api/health
```

正常返回：

```json
{ "data": { "status": "OK", "database": "OK" } }
```

**启动顺序**（见 [src/main.ts](src/main.ts)）：加载 `.env` → 连接 Prisma/SQLite → 创建 BrowserManager → `recovery.run()`（先恢复）→ `scheduler.start()`（再调度）→ 监听 HTTP。

**停止**：`Ctrl+C`（SIGINT）触发优雅关闭，顺序为 停 Scheduler → 关闭所有 SSE → 停 HTTP → 关 Browser → disconnect Prisma。


---

## 8. 首次 Gemini 登录

personChat **不使用 Gemini API Key**，需要通过 Chromium **人工登录** Google / Gemini 一次；登录态保存在独立持久化 profile 中，之后复用。

登录流程：

```text
启动 Backend
      ↓
POST /api/provider/open      # 启动 BrowserManager，打开 / 聚焦 Gemini 页面
      ↓
在弹出的 Chromium 里人工登录 Google
      ↓
进入 Gemini
      ↓
POST /api/provider/restart   # 用同一 profile 重启 Context 并重新打开 Gemini
      ↓
GET  /api/provider/status    # 轮询直到 status = READY
      ↓
READY
```

curl 示例（状态码以实际 Controller 为准）：

```bash
# 打开 Gemini（成功 200；未登录时 data.status = LOGIN_REQUIRED）
curl -X POST http://127.0.0.1:3010/api/provider/open
# → 200 { "data": { "provider": "GEMINI_WEB", "status": "LOGIN_REQUIRED" } }

# 人工在浏览器完成登录后，重启 Context 复用同一 profile
curl -X POST http://127.0.0.1:3010/api/provider/restart
# → 200 { "data": { "provider": "GEMINI_WEB", "status": "READY" } }

# 查询状态（不启动浏览器）
curl http://127.0.0.1:3010/api/provider/status
# → 200 { "data": { "provider": "GEMINI_WEB", "status": "READY" } }
```

**关于 profile：**

- **不要使用日常 Chrome 的 Default Profile。** 用 `BROWSER_PROFILE_DIR` 指定的**独立持久化 profile**（默认 `./data/browser-profile`）。
- 同一个 profile **只能被一个 personChat Backend 实例占用**。
- 遇到 `PROVIDER_PROFILE_IN_USE`（HTTP 500）时，**不要直接删除 Chromium 的 lock 文件**；应先检查并关闭仍占用该 profile 的旧实例（残留的 Backend 进程或它拉起的 Chromium），再重新启动。
- `BROWSER_HEADLESS=false`（默认）时浏览器窗口可见，便于人工登录；无人值守场景不适用（见 [§21](#21-已知限制)）。

---

## 9. 环境变量

以 [.env.example](.env.example) 与 [src/config/env.ts](src/config/env.ts) 为准：

| 变量 | 类型 / 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `NODE_ENV` | `development` / `test` / `production` | `development` | 运行环境 |
| `HOST` | 字符串 | `127.0.0.1` | 监听地址 |
| `PORT` | 整数 1–65535 | `3010` | 监听端口 |
| `DATABASE_URL` | 字符串（**必填，无默认值**） | — | SQLite 连接串，如 `file:./data/database/app.db` |
| `LOG_LEVEL` | `fatal`/`error`/`warn`/`info`/`debug`/`trace`/`silent` | `info` | Pino 日志级别 |
| `BROWSER_PROFILE_DIR` | 字符串 | `./data/browser-profile` | 持久化 Chromium profile 目录 |
| `BROWSER_HEADLESS` | `true` / `false`（字符串） | `false` | 是否无头运行浏览器 |
| `GEMINI_BASE_URL` | URL | `https://gemini.google.com/app` | Gemini Web 入口 |
| `GEMINI_RESPONSE_TIMEOUT_MS` | 正整数 | `300000` | 单次 Prompt 从发送到读回最终回答的等待上限 |
| `REQUEST_EXECUTION_TIMEOUT_MS` | 正整数 | `600000` | Scheduler 单条 Request 执行 watchdog 上限 |
| `STREAMING_UPDATE_INTERVAL_MS` | 整数 ≥ 0 | `300` | 流式回答期间 Assistant Message 的最小写库间隔 |

**强制跨字段校验（ISSUE-03）：**

```text
REQUEST_EXECUTION_TIMEOUT_MS  必须严格大于  GEMINI_RESPONSE_TIMEOUT_MS
```

相等同样非法。违反时启动即抛 `VALIDATION_ERROR`（fail-fast），不会进入运行态。原因：watchdog 只应兜「执行器挂死连自身超时都不返回」的极端情况，正常超时必须由 Adapter 的 `GEMINI_RESPONSE_TIMEOUT_MS` 先触发；若 watchdog ≤ 响应上限，会把正常执行误判为 `TIMEOUT`。

> 说明：`BROWSER_HEADLESS` 用「字符串 `true`/`false`」解析（`z.coerce.boolean` 会把 `"false"` 误判为 `true`，故不使用）。

---

## 10. Provider 状态

`BrowserProviderStatus` 枚举定义于 [src/providers/gemini/browser-driver.ts](src/providers/gemini/browser-driver.ts)。**初始 / 未启动状态是 `STOPPED`（源码中不存在 `NOT_CREATED`）。**

| 状态 | 含义 |
| --- | --- |
| `STOPPED` | 浏览器未启动，或 Context / Page 已关闭（初始状态） |
| `STARTING` | 正在创建 Persistent Context |
| `LOGIN_REQUIRED` | 浏览器正常，但 Gemini 未确认登录 |
| `READY` | Gemini 页面可访问且已登录，可执行请求 |
| `BUSY` | 正在执行一个 Request（Scheduler 认领后置位，期间禁止导航 / restart） |
| `ERROR` | Browser / Context / Page 初始化失败或异常（如 profile 被占用、导航失败、renderer 崩溃） |

`GET /api/provider/status` 返回的即此枚举值。`POST /api/provider/restart` 在 `BUSY` 时会拒绝（抛 `PROVIDER_NOT_READY`），避免炸掉正在生成的请求。

---

## 11. Request 状态机

Request 状态取值（[src/modules/request/request.types.ts](src/modules/request/request.types.ts)）：`PENDING` / `PROCESSING` / `CANCELLING` / `SUCCESS` / `FAILED` / `CANCELLED` / `TIMEOUT`。

```text
PENDING
  ├─ PROCESSING
  │    ├─ SUCCESS
  │    ├─ FAILED
  │    ├─ TIMEOUT
  │    └─ CANCELLING
  │         ├─ CANCELLED
  │         ├─ SUCCESS      # 竞态边：Adapter 明确确认生成完成
  │         └─ FAILED
  └─ CANCELLED              # PENDING 直接被取消
```

- **活动状态**（同 Conversation 最多一个）：`PENDING` / `PROCESSING` / `CANCELLING`
- **在飞状态**（Gemini 页面上可能仍在生成，可走向任意终态）：`PROCESSING` / `CANCELLING`

**Request → Assistant Message 状态映射**（唯一来源 [src/modules/request/request.consistency.ts](src/modules/request/request.consistency.ts)）：

| Request 状态 | Assistant Message 状态 |
| --- | --- |
| `PENDING` | `PENDING` |
| `PROCESSING` | `STREAMING` |
| `CANCELLING` | `STREAMING` |
| `SUCCESS` | `COMPLETED` |
| `FAILED` | `FAILED` |
| `TIMEOUT` | `FAILED` |
| `CANCELLED` | `CANCELLED` |

> 注意 `CANCELLING → STREAMING`（不是 `CANCELLED`）：取消受理后 Gemini 仍在吐尾部内容，Assistant 必须保持 `STREAMING`，流式写入与终态前的强制 flush 才仍然有效。Message 状态取值：`PENDING` / `STREAMING` / `COMPLETED` / `FAILED` / `CANCELLED`；USER 消息一旦入库即为 `COMPLETED`。

---

## 12. Scheduler（全局单飞）

见 [src/modules/request/request.scheduler.ts](src/modules/request/request.scheduler.ts)。

- **全局最多 1 个 Gemini Request 在执行。** 不同 Conversation 都可以创建各自的 PENDING Request，但 Scheduler 全局串行、逐个认领。
- 默认每 `1000ms` 扫描一次 PENDING；新 Request 提交后会 `notify()` 立即触发一轮，不必等下个周期。
- 认领顺序：多个 PENDING 按 `createdAt` 从老到新。
- **Provider 门禁**（认领之前）：`READY` → 放行执行；`LOGIN_REQUIRED` → 认领后直接判 `FAILED`（`PROVIDER_LOGIN_REQUIRED`），从不触碰 Adapter；启动 / 导航等瞬时故障 → 本轮 `WAIT`，Request 留在 PENDING 等待，不失败。
- 执行期间 `BrowserManager` 置 `BUSY`。
- **只有确认 Gemini 已停止生成（`confirmIdle`）或 Browser 已安全重置后，才释放全局 slot：**
  - `confirmIdle` 为真 → `clearBusy()`，下一条可以开始；
  - `confirmIdle` 为假 → 记 `PROVIDER_CANCELLATION_UNCONFIRMED` 并 `restart()` 重建 Browser，Scheduler 暂停到 Provider 重新 `READY`。
- **watchdog**：单条执行超过 `REQUEST_EXECUTION_TIMEOUT_MS` 判 `TIMEOUT`（先 `abort` 让 Adapter 走 stopGeneration，再给一段宽限期确认）。
- **失败映射**：`PROVIDER_RESPONSE_TIMEOUT` → `TIMEOUT`，其余一律 `FAILED`；**绝不自动重试**。

---

## 13. SSE 流式推送

Endpoint（[src/modules/sse/sse.controller.ts](src/modules/sse/sse.controller.ts)）：

```text
GET /api/requests/:id/events        # Content-Type: text/event-stream
```

事件类型（[src/modules/sse/sse.service.ts](src/modules/sse/sse.service.ts)）：`connected` / `snapshot` / `delta` / `status` / `error`。

帧序：

```text
connected → (snapshot | delta)* → status         # 正常终态
connected → (snapshot | delta)* → error → status # FAILED / TIMEOUT，error 帧在 status 之前
```

| 事件 | 含义 |
| --- | --- |
| `connected` | 连接建立，`data.requestId` |
| `snapshot` | 当前**完整**回答文本（首次连接 / 断线重连 / 前文被改写时整段覆盖） |
| `delta` | 相对**本连接已发前缀**的新增部分 |
| `status` | Request 状态（同时给出消息态 `status` 与 `requestStatus`，以及 `errorCode` / `errorMessage`） |
| `error` | Request 失败信息（`code` / `message`），仅 `FAILED` / `TIMEOUT` 终态前发出 |

要点：

- **SSE 断开不会取消 Request**，Gemini 执行继续；客户端断开只结束这一条连接。
- **数据库是最终权威数据源**：终态内容以数据库为准，漏收过广播的连接（含断线重连）最终一致。
- 断线重连（如页面刷新）：新连接先拿一次 `snapshot` 全量，再继续收 `delta` 增量，不重放历史 delta。
- 未知 Request：在写 SSE 头**之前**就返回 `404`（`REQUEST_NOT_FOUND`），响应不是事件流。
- 落库节流：SSE 按每次文本变化立即推送，数据库只按 `STREAMING_UPDATE_INTERVAL_MS` 间隔写入。

---

## 14. Cancel 取消

`POST /api/requests/:id/cancel`（[src/modules/request/request.service.ts](src/modules/request/request.service.ts)）。

```text
PENDING     → CANCELLED                              # 直接落终态，HTTP 200
PROCESSING  → CANCELLING → 点击 Gemini Stop → confirmIdle → CANCELLED   # HTTP 202 受理，终态经 SSE 到达
```

- **取消后保留已生成的 Assistant 部分内容**（`cancelled()` 把部分回答连同 `CANCELLED` 状态一并落库）。
- 幂等：对已是 `CANCELLING` / `CANCELLED` 的 Request 再次取消 → `noop`，HTTP `200`（双击停止是正常用户行为）。
- 已终态（`SUCCESS` / `FAILED` / `TIMEOUT` / `CANCELLED` 之外的终局）不可取消 → `409` `REQUEST_NOT_CANCELLABLE`。
- **如果无法确认 Gemini 真的停止**：本次 Request 判 `FAILED`，错误码 `PROVIDER_CANCELLATION_UNCONFIRMED`，随后 BrowserManager 重建 Page/Context，Scheduler 暂停到 Provider 重新 `READY`。

HTTP 状态码小结：

| 场景 | 状态码 |
| --- | --- |
| `PENDING → CANCELLED` | `200` |
| `PROCESSING → CANCELLING`（受理，终态稍后到） | `202` |
| 已 `CANCELLING` / `CANCELLED` 再取消（noop） | `200` |
| 已终态不可取消 | `409` |
| Request 不存在 | `404` |

---

## 15. Recovery 重启恢复

服务启动时（先于 Scheduler）执行，见 [src/modules/request/request.recovery.ts](src/modules/request/request.recovery.ts)：

| 重启前状态 | 恢复动作 | 错误码 |
| --- | --- | --- |
| `PENDING` | 不动，Scheduler 首轮扫描自然重新排队 | — |
| `PROCESSING` | → `FAILED` | `SERVER_RESTARTED_DURING_PROCESSING` |
| `CANCELLING` | → `FAILED` | `SERVER_RESTARTED_DURING_CANCELLING` |

- **`PROCESSING` / `CANCELLING` 不自动重发 Gemini Prompt**：无法确认上一进程是否已把 Prompt 提交给 Gemini，强制 `FAILED` 且禁止重发。
- 对应 Assistant Message 一律 → `FAILED`（不落 `CANCELLED`，否则会出现 Request `FAILED` + Assistant `CANCELLED` 的非法配对）。
- 恢复末尾跑一次 Request ↔ Assistant 配对检查：**只发现、只记 error，不修复**（自动修复会销毁事故现场）。

---

## 16. 数据存储

数据模型见 [prisma/schema.prisma](prisma/schema.prisma)：

| 模型 | 说明 |
| --- | --- |
| `Conversation` | 业务会话：`title` / `status`（`ACTIVE`/`ARCHIVED`/`DELETED`）/ `provider` / `providerConversationUrl`（唯一，可空）/ 时间戳 |
| `Message` | 消息：`role`（USER/ASSISTANT）/ `content` / `status` / `position`（`(conversationId, position)` 唯一） |
| `ModelRequest` | 一次「User Message → Provider → Assistant Message」的执行记录：`idempotencyKey`（唯一）/ `requestFingerprint` / `status` / `attemptCount` / `errorCode` / `errorMessage` / 时间戳 |

要点：

- **SQLite / Prisma 是权威数据源。**
- DB 文件位置由 `DATABASE_URL` 决定（默认 `file:./data/database/app.db`）。
- `BROWSER_PROFILE_DIR`（默认 `./data/browser-profile`）是 Chromium 持久化 profile，**不属于聊天数据**，但等价于持久登录态（见 [§23](#23-安全说明)）。
- **不要把生产 DB 提交到 Git**（`data/` 下的正式数据应视为本地 / 敏感数据）。

---

## 17. API 概览

以实际 Router / Controller 为准（[src/app.ts](src/app.ts) 挂载）。所有错误响应统一为 `{ "error": { "code", "message", "requestId" } }`，`requestId` 与响应头 `x-request-id` 一致。

| 方法 | 路径 | 成功码 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/api/health` | `200` / `503` | 健康检查；DB 不可达返回 `503` |
| `GET` | `/api/provider/status` | `200` | 查询 Provider 状态（不启动浏览器） |
| `POST` | `/api/provider/open` | `200` | 启动 BrowserManager，打开 / 聚焦 Gemini |
| `POST` | `/api/provider/restart` | `200` | 关闭 Context → 同 profile 重启 → 打开 Gemini；`BUSY` 时拒绝 |
| `POST` | `/api/conversations` | `201` | 创建会话（`title` 可选） |
| `GET` | `/api/conversations` | `200` | 列表；`?status=ACTIVE\|ARCHIVED`（默认 `ACTIVE`）、`limit`（1–100，默认 30）、`cursor` |
| `GET` | `/api/conversations/:id` | `200` | 会话详情 |
| `PATCH` | `/api/conversations/:id` | `200` | 改 `title` 和 / 或 `status`（`ACTIVE`↔`ARCHIVED`，即重命名 / 归档 / 恢复） |
| `DELETE` | `/api/conversations/:id` | `204` | 软删除（标记 `DELETED`，不可恢复） |
| `GET` | `/api/conversations/:id/messages` | `200` | 消息列表（`position` ASC，Assistant 附带 Request 摘要） |
| `POST` | `/api/conversations/:id/messages` | `202` / `200` | 发送消息；需 `Idempotency-Key` 头。首次创建 Request → `202`；幂等命中 → `200` |
| `GET` | `/api/requests/:id` | `200` | 查询 Request 当前状态 |
| `POST` | `/api/requests/:id/cancel` | `202` / `200` | 取消；`PROCESSING→CANCELLING` → `202`，`PENDING→CANCELLED` / noop → `200` |
| `GET` | `/api/requests/:id/events` | `200` | SSE 事件流（`text/event-stream`） |

**关键成功状态码（从源码核对）：**

- `DELETE /api/conversations/:id` → **`204`**（软删除，无响应体）
- `POST /api/provider/restart` → **`200`**（`BUSY` 时 → `PROVIDER_NOT_READY`，HTTP 500）
- `POST /api/requests/:id/cancel` → **`202`**（受理，`PROCESSING→CANCELLING`）/ **`200`**（`PENDING→CANCELLED` 或幂等 noop）
- `POST /api/conversations/:id/messages` → **`202`**（新建）/ **`200`**（幂等命中）

发送消息示例：

```bash
curl -X POST http://127.0.0.1:3010/api/conversations/<CONV_ID>/messages \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 3f9a1c22-0001" \
  -d '{"content":"你好"}'
# → 202 { "data": { "request": {...}, "userMessage": {...}, "assistantMessage": {...}, "deduplicated": false } }
```

---

## 18. 错误码与 HTTP 映射

错误码定义于 [src/common/errors/error-codes.ts](src/common/errors/error-codes.ts)，HTTP 映射唯一来源于 [src/common/errors/error-code-map.ts](src/common/errors/error-code-map.ts)（抛出点不得自行决定 HTTP 状态）。

| HTTP | 错误码 |
| --- | --- |
| `400` | `VALIDATION_ERROR` |
| `401` | `PROVIDER_LOGIN_REQUIRED` |
| `404` | `CONVERSATION_NOT_FOUND`、`REQUEST_NOT_FOUND` |
| `409` | `CONVERSATION_DELETED`、`CONVERSATION_ARCHIVED`、`CONVERSATION_REQUEST_IN_PROGRESS`、`IDEMPOTENCY_KEY_REUSED`、`REQUEST_NOT_CANCELLABLE`、`PROVIDER_CONVERSATION_UNAVAILABLE` |
| `429` | `PROVIDER_RATE_LIMITED`（仅保留映射，无可靠真实判据，见 [§21](#21-已知限制)） |
| `500` | `SERVER_RESTARTED_DURING_PROCESSING`、`SERVER_RESTARTED_DURING_CANCELLING`、`STREAMING_UPDATE_FAILED`、`SSE_CONNECTION_ERROR`、`PROVIDER_NOT_READY`、`PROVIDER_PROFILE_IN_USE`、`PROVIDER_BROWSER_START_FAILED`、`PROVIDER_PAGE_CLOSED`、`PROVIDER_BROWSER_CRASHED`、`PROVIDER_NAVIGATION_FAILED`、`PROVIDER_DOM_CHANGED`、`PROVIDER_RESPONSE_TIMEOUT`、`PROVIDER_CANCELLATION_UNCONFIRMED`、`DATABASE_ERROR`、`INTERNAL_ERROR` |

错误响应体：

```json
{ "error": { "code": "CONVERSATION_NOT_FOUND", "message": "Conversation not found", "requestId": "..." } }
```

- 非法 JSON body → `400 VALIDATION_ERROR`
- Prisma / SQLite 运行时异常 → `500 DATABASE_ERROR`（内部细节只进日志，不回传响应）
- 其他未分类异常 → `500 INTERNAL_ERROR`

---

## 19. 开发与测试

脚本以 [package.json](package.json) 为准：

```bash
yarn typecheck    # tsc -p tsconfig.json --noEmit
yarn test         # vitest run
yarn build        # tsc -p tsconfig.json → dist/
```

V1 冻结版本验收结果：

```text
Backend: 209 tests PASS（57 suites，0 failed）
```

> 这是 **V1 冻结版本（commit `4dfb074`）的历史验收记录**，不代表未来所有 commit 自动通过。测试分为 `tests/unit/`（Fake driver / Fake adapter，不依赖真实浏览器与 Google）与 `tests/integration/`（真 SQLite + Fake Adapter 全链路）。

---

## 20. V1 验收状态

```text
V1 Final Acceptance: PASS WITH KNOWN LIMITATIONS
```

冻结版本：

```text
Backend:  4dfb074a48f236b2b3fa20dc7fe88d4e562ff073
Frontend: f1c5c8af56615152513ab3d41081cd48ed434301
```

核心验收覆盖（不复制完整验收报告）：

- Real Gemini E2E（真实 Chromium + gemini.google.com）
- 多轮上下文
- SSE 断线重连
- Real Cancel（真实点击 Gemini Stop）
- Page Close
- Browser Crash
- Provider Conversation 失效
- 2h soak（长稳）
- Real Gemini endurance
- DB 一致性

---

## 21. 已知限制

### 单用户

当前无多用户隔离：所有会话共享同一个 Backend、同一个 Browser profile、同一个 Google 登录态。

### 单实例

SQLite + 单 Browser Profile + 全局单飞，决定只能单实例运行。同一 profile 不能被两个 Backend 实例同时占用（否则 `PROVIDER_PROFILE_IN_USE`）。

### Google 登录人工完成

无法自动登录 Google。首次（或登录态失效后）必须人工在弹出的 Chromium 中完成登录，不适合无人值守部署。

### Gemini DOM 依赖

后端靠 DOM selector 与 Gemini Web 交互，Gemini 前端改版可能导致 `PROVIDER_DOM_CHANGED`，需要更新 [src/providers/gemini/gemini.selectors.ts](src/providers/gemini/gemini.selectors.ts)。

### RATE_LIMITED

`PROVIDER_RATE_LIMITED`（HTTP `429`）目前**仅保留错误码与映射，没有可靠的真实判据**，不保证能被准确触发。

### 公网部署

当前默认监听 `127.0.0.1`，**不应直接作为公网多租户服务暴露**。

---

## 22. 常见问题

| 现象 / 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `PROVIDER_LOGIN_REQUIRED`（401 / status `LOGIN_REQUIRED`） | Gemini 未登录或登录态失效 | `POST /api/provider/open` 打开浏览器人工登录 → `POST /api/provider/restart` → 轮询 `status` 到 `READY` |
| `PROVIDER_PROFILE_IN_USE`（500） | profile 被另一进程占用 | **不要删 lock 文件**；先找到并关闭仍占用 `BROWSER_PROFILE_DIR` 的旧 Backend / Chromium 实例，再重启 |
| `PROVIDER_DOM_CHANGED`（500） | Gemini 改版导致 selector 失效 | 更新 `gemini.selectors.ts` 后重新构建；临时可 `restart` 重试 |
| `PROVIDER_PAGE_CLOSED`（500） | Gemini 页面被单独关闭（Context 仍在） | 再次 `POST /api/provider/open` 会重建 Page，不二次启动 Chromium |
| `PROVIDER_BROWSER_CRASHED`（500） | Chromium / Context / renderer 崩溃 | 由 Scheduler 触发 `restart` 重建；必要时人工 `POST /api/provider/restart` |
| `PROVIDER_CONVERSATION_UNAVAILABLE`（409） | 已绑定的 Gemini 会话被踢回 `/app` 或跳到别的会话 id | 该会话无法继续复用；新建 Conversation 重新发起 |
| `DATABASE_ERROR`（500） | Prisma / SQLite 运行时异常 | 查看服务端日志定位；确认 `DATABASE_URL` 指向可写文件、迁移已 `migrate deploy` |
| 启动即 `VALIDATION_ERROR` | 环境变量非法 | 检查 `DATABASE_URL` 是否缺失、`REQUEST_EXECUTION_TIMEOUT_MS` 是否严格大于 `GEMINI_RESPONSE_TIMEOUT_MS` |

---

## 23. 安全说明

**不要提交到 Git：**

- `.env`
- Google Cookie / Token
- Browser Profile（`BROWSER_PROFILE_DIR`）
- SQLite 正式数据（`DATABASE_URL` 指向的 DB 文件）

**日志禁止记录（prd §14，已在源码落实）：**

- 完整 Prompt 原文
- 完整 Answer 原文
- Gemini Conversation URL（未脱敏）
- Gemini Conversation ID
- 认证 Token
- Cookie

日志只保留 id、长度、耗时、错误码等非敏感字段。例如 `gemini page open` 只记 `onConversation: boolean`（是否落在具体会话），不记 URL；`request completed` 只记 `answerLength`，不记 `conversationUrl`。

> **Browser Profile 等价于持久登录态**，拿到它等于拿到你的 Google 登录状态，必须按敏感数据保护。

---

## 24. 相关仓库

```text
Frontend: https://github.com/hukaiedu/NextChatfront
```

Frontend based on NextChat.

后端仓库：

```text
Backend:  https://github.com/hukaiedu/NextChatBack
```

---

> 本 README 以冻结 commit `4dfb074a48f236b2b3fa20dc7fe88d4e562ff073` 的源码为准编写。若文档与源码冲突，以该 commit 的源码为准。
