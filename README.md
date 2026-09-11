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
- [25. V1.1 模型选择（Gemini Web）](#25-v11-模型选择gemini-web)
- [26. 访问鉴权（SEC-1）](#26-访问鉴权sec-1)

---

## 1. 项目简介

personChat Backend 是 personChat 的服务端。

它负责 Conversation、Message、Request 的持久化，通过 Scheduler 串行调度 Gemini 请求，通过 Playwright 驱动持久化 Chromium 与 Gemini Web 交互，并通过 SSE 向前端推送流式回答。

**SQLite / Prisma 是聊天主数据的权威数据源。** SSE 只是实时推送通道，任何时刻以数据库为准。

**当前定位：**

- 单用户
- 单 Backend 实例
- 自托管
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
- 图片附件消息（V1.2：PNG / JPEG / WebP / GIF）
- 纯图片消息（`content` 为空 + 附件 ≥ 1，见 [§17](#17-api-概览)）
- 图片附件注入 Gemini Web composer
- 请求附件份数 `attachmentCount` 持久化（图片字节不落库）

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

环境变量清单以仓库根目录 [.env.example](.env.example) 与 [src/config/env.ts](src/config/env.ts) 为**唯一权威来源**（本节不再复制完整清单，避免与代码漂移）。快速启动至少确认以下 4 项：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | **必填，无默认值**；缺失 / 为空会在启动时抛 `VALIDATION_ERROR` 并 fail-fast |
| `PORT` | HTTP 监听端口，默认 `3010` |
| `BROWSER_PROFILE_DIR` | Chromium 持久化 profile（**Gemini 登录态所在**），代码默认 `./data/browser-profile` |
| `BROWSER_PROXY_URL` | 可选：Playwright Chromium 出网代理（Backend 与 `browser:login` 共用），见 [§9](#9-环境变量) |

> `.env.example` **不含任何真实 Cookie / Token / Google 凭证**；真实 `.env` 不要提交（见 [§23](#23-安全说明)）。

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

> 迁移文件位于 `prisma/migrations/`。部署时使用 `yarn prisma migrate deploy` 应用仓库中所有已提交 migration；该命令只应用已有迁移，不会交互式生成新迁移，适合首次初始化与部署。不要依赖 README 中的 migration 数量，以 `prisma/migrations/` 为准。

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

> `yarn start` 等价于 `node dist/main.js`（需先 `yarn build`）。所有脚本以 [package.json](package.json) 的 `scripts` 为准：`dev` / `build` / `typecheck` / `start` / `test` / `prisma:generate` / **`browser:login`**。
>
> `yarn browser:login` 使用与 Backend 相同的环境配置启动**可见** Chromium，用于完成或刷新 Gemini 登录态；它执行 `dist/scripts/browser-login.js`，因此**必须先 `yarn build`**（流程见 [§8](#8-首次-gemini-登录)）。

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

**首次登录（推荐流程）：**

```text
1. 配置 .env（至少 DATABASE_URL / BROWSER_PROFILE_DIR，见 §7.4）
2. yarn build                        # browser:login 执行 dist/，必须先构建
3. 停止正在使用同一 BROWSER_PROFILE_DIR 的 Backend
4. yarn browser:login                # 打开可见 Chromium（强制 headed，不受 BROWSER_HEADLESS 影响）
5. 在弹出的 Chromium 中完成 Google / Gemini 登录
6. CLI 检测到登录成功后自动关闭 Chromium 并 exit 0
7. 启动 Backend（yarn start / node dist/main.js）
8. 检查运行状态：GET /api/health 与 GET /api/browser/status（RUNNING + providerLoggedIn=true）
```

- **browser:login 不需要按 Enter 结束**：登录成功后 CLI 自动关闭浏览器并退出（exit 0）；已登录的 profile 会直接输出 `already logged in; closing browser` 并退出。
- CLI 等待登录期间持续轮询（750ms），可随时 `Ctrl+C` 中止（退出码 130）；若打开浏览器遇到环境 / 网络类错误，会自动重试至多 2 次（间隔 5s），仍失败则 exit 1（只输出错误码摘要，不含任何凭据）。
- `POST /api/provider/open` / `POST /api/provider/restart` 等 Provider 接口仍然保留，用于运行期交互（见 [§17](#17-api-概览)）；**首次登录与登录态恢复请使用上述 `browser:login` 流程**。

**single-owner 纪律（profile 独占）：**

- 同一个 `BROWSER_PROFILE_DIR` **同一时刻只能有一个持有者**（Backend 或 `browser:login`）：运行 `browser:login` 前先停止使用该 profile 的 Backend；`browser:login` 成功退出后再启动 Backend。
- Linux 上 Chromium 通常以 ProcessSingleton 阻止第二持有者；**Windows 上不应依赖这一保护**，仍必须遵守 single-owner 纪律。
- **不要**删除 `Singleton*` 锁文件来“解锁”，也不要强制抢占 profile 或复制生产 profile / Cookie。
- 遇到 `PROVIDER_PROFILE_IN_USE`（HTTP 500）时，先检查并关闭仍占用该 profile 的旧实例（残留 Backend 进程或它拉起的 Chromium），再重新启动。

**profile 与登录态：**

- **不要使用日常 Chrome 的 Default Profile。** 用 `BROWSER_PROFILE_DIR` 指定的**独立持久化 profile**（代码默认 `./data/browser-profile`）。
- `BROWSER_PROFILE_DIR` 保存 **Gemini 登录态**（等价于持久凭证）；**生产环境必须指向持久化目录**，例如部署 SOP 使用的 `/var/lib/personchat/browser-profile`（该绝对路径只是部署示例，不是代码默认值）。
- 登录态恢复边界：
  - profile 仍存在 + Google session 有效 → Backend 重启可直接复用，无需重新登录；
  - profile 丢失、或 Google/Gemini session 失效 → **重跑 `browser:login`**。
- 系统**不会**自动完成 Google 登录（不提供无人值守的自动重新认证）。

**无图形界面服务器：**

- `browser:login` 使用 **headed（可见窗口）Chromium**；SSH-only Linux 服务器首次登录需要可用的图形显示环境（如 Xvfb + 临时 VNC）。完整步骤见 [docs/P8_DEPLOYMENT_SOP.md](docs/P8_DEPLOYMENT_SOP.md) §9。

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
| `BROWSER_PROXY_URL` | `http://` / `https://` / `socks5://` URL（可选，**禁止携带账号密码**） | 未设置 | 仅 Playwright Chromium 使用的显式代理；**Backend 与 `browser:login` 共用同一配置**。未设置时**不向 Playwright 传 proxy**（浏览器沿用自身默认 / 系统配置，如 Windows 开发环境为继承系统代理）；服务器部署建议显式配置（示例 `http://127.0.0.1:7892`） |
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
>
> Backend main 与 `browser:login` **都会加载项目 `.env`**（P1-01 起两入口一致）；配置优先级：显式 shell / process.env > `.env` > 代码默认值。

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
| `PENDING` + `attachmentCount = 0` | 不动，Scheduler 首轮扫描自然重新排队 | — |
| `PENDING` + `attachmentCount > 0` | → `FAILED`（附件字节只存在于上一进程内存，重启后不可恢复，禁止降级成纯文本发送） | `SERVER_RESTARTED_DURING_PROCESSING` |
| `PROCESSING` | → `FAILED` | `SERVER_RESTARTED_DURING_PROCESSING` |
| `CANCELLING` | → `FAILED` | `SERVER_RESTARTED_DURING_CANCELLING` |

- **`PROCESSING` / `CANCELLING` / 带附件的 `PENDING` 不自动重发 Gemini Prompt**：无法确认上一进程是否已把 Prompt 提交给 Gemini（带附件 PENDING 则是附件字节已随进程丢失），强制 `FAILED` 且禁止重发，由用户显式重新发送。
- 对应 Assistant Message 一律 → `FAILED`（不落 `CANCELLED`，否则会出现 Request `FAILED` + Assistant `CANCELLED` 的非法配对）。
- 恢复末尾跑一次 Request ↔ Assistant 配对检查：**只发现、只记 error，不修复**（自动修复会销毁事故现场）。

---

## 16. 数据存储

数据模型见 [prisma/schema.prisma](prisma/schema.prisma)：

| 模型 | 说明 |
| --- | --- |
| `Conversation` | 业务会话：`title` / `status`（`ACTIVE`/`ARCHIVED`/`DELETED`）/ `provider` / `providerConversationUrl`（唯一，可空）/ 时间戳 |
| `Message` | 消息：`role`（USER/ASSISTANT）/ `content` / `status` / `position`（`(conversationId, position)` 唯一） |
| `ModelRequest` | 一次「User Message → Provider → Assistant Message」的执行记录：`userMessageId` / `assistantMessageId` / `idempotencyKey`（唯一）/ `requestFingerprint` / `status` / `requestedModelKey` / `resolvedModelKey` / `resolvedModelLabel`（V1.1 模型字段）/ `attachmentCount`（V1.2：本次请求的附件份数，图片字节不落库）/ `attemptCount` / `errorCode` / `errorMessage` / 时间戳 |

要点：

- **SQLite / Prisma 是权威数据源。**
- DB 文件位置由 `DATABASE_URL` 决定。仓库 [.env.example](.env.example) 使用 `file:./data/database/app.db` 作为示例；代码本身不提供 `DATABASE_URL` 默认值（未配置即启动失败）。
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
| `GET` | `/api/provider/models` | `200` | 模型目录（V1.1，实时读取 Gemini Web）；`LOGIN_REQUIRED` → 401，其余非 READY → 500 |
| `GET` | `/api/browser/status` | `200` | 浏览器状态快照（只读，**不启动浏览器**；含 `state` / `providerLoggedIn` / `activeRequests` / `lastError` 等字段） |
| `POST` | `/api/browser/restart` | `200` | 关闭并重启浏览器（保留 profile 登录态），返回重启后的新快照；重启中 / 有在飞 Request / `BUSY` → `409 BROWSER_RESTART_CONFLICT`，30s 未完成 → `504 BROWSER_RESTART_TIMEOUT` |
| `POST` | `/api/conversations` | `201` | 创建会话（`title` 可选） |
| `GET` | `/api/conversations` | `200` | 列表；`?status=ACTIVE\|ARCHIVED`（默认 `ACTIVE`）、`limit`（1–100，默认 30）、`cursor` |
| `GET` | `/api/conversations/:id` | `200` | 会话详情 |
| `PATCH` | `/api/conversations/:id` | `200` | 改 `title` / `status`（`ACTIVE`↔`ARCHIVED`）；V1.1 起支持 `preferredModelKey`（会话模型偏好，显式 `null` = 恢复默认模型） |
| `DELETE` | `/api/conversations/:id` | `204` | 软删除（标记 `DELETED`，不可恢复） |
| `GET` | `/api/conversations/:id/messages` | `200` | 消息列表（`position` ASC，Assistant 附带 Request 摘要） |
| `POST` | `/api/conversations/:id/messages` | `202` / `200` | 发送消息；需 `Idempotency-Key` 头；body：`content`（可为空字符串，仅限纯图片消息）/ 可选 `modelKey`（V1.1）/ 可选 `attachments`（V1.2，见下文「图片附件」）。首次创建 Request → `202`；幂等命中 → `200` |
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

**V1.2 图片附件（`attachments`）：**

```json
{
  "content": "",
  "attachments": [
    { "name": "photo.jpg", "mimeType": "image/jpeg", "data": "data:image/jpeg;base64,..." }
  ]
}
```

- 支持 PNG / JPEG / WebP / GIF（其余类型 → `415 UNSUPPORTED_ATTACHMENT_TYPE`）；最多 4 张；单张解码后 ≤ 5MiB、合计解码后 ≤ 10MiB（超限 → `413 ATTACHMENT_TOO_LARGE`；整个请求体超限 → `413 PAYLOAD_TOO_LARGE`）。
- `data` 必须是 `data:image/...;base64,` 形式的 data URL；声明的 `mimeType`、data URL 前缀、文件真实魔数三者必须一致，否则 415。
- **纯图片消息**：`content=""` + `attachments` 至少 1 张是合法请求；无附件时 `attachments` 可省略（旧客户端行为不变）；`content` 与附件同时为空 → `400 VALIDATION_ERROR`。
- **图片字节不落库**：仅持久化本次请求的附件份数（`ModelRequest.attachmentCount`）。响应中的 `userMessage.attachmentCount` = 本次请求附件份数（纯文本 = 0）。
- 消息列表 `GET /api/conversations/:id/messages` 每条 item 均带 `attachmentCount`：USER = 对应 Request 的份数（无则 0），ASSISTANT 恒 0（原图字节从未持久化）。

---

## 18. 错误码与 HTTP 映射

错误码定义于 [src/common/errors/error-codes.ts](src/common/errors/error-codes.ts)，HTTP 映射唯一来源于 [src/common/errors/error-code-map.ts](src/common/errors/error-code-map.ts)（抛出点不得自行决定 HTTP 状态）。

| HTTP | 错误码 |
| --- | --- |
| `400` | `VALIDATION_ERROR` |
| `401` | `PROVIDER_LOGIN_REQUIRED`、`AUTH_REQUIRED`、`AUTH_INVALID_CREDENTIALS` |
| `403` | `AUTH_CSRF_REJECTED` |
| `404` | `CONVERSATION_NOT_FOUND`、`REQUEST_NOT_FOUND` |
| `409` | `CONVERSATION_DELETED`、`CONVERSATION_ARCHIVED`、`CONVERSATION_REQUEST_IN_PROGRESS`、`IDEMPOTENCY_KEY_REUSED`、`REQUEST_NOT_CANCELLABLE`、`PROVIDER_CONVERSATION_UNAVAILABLE`、`BROWSER_RESTART_CONFLICT` |
| `413` | `PAYLOAD_TOO_LARGE`（请求体超限）、`ATTACHMENT_TOO_LARGE`（图片张数 / 单张 / 合计超限） |
| `415` | `UNSUPPORTED_ATTACHMENT_TYPE` |
| `429` | `PROVIDER_RATE_LIMITED`（仅保留映射，无可靠真实判据，见 [§21](#21-已知限制)）、`AUTH_RATE_LIMITED`（携带 `Retry-After`） |
| `500` | `SERVER_RESTARTED_DURING_PROCESSING`、`SERVER_RESTARTED_DURING_CANCELLING`、`STREAMING_UPDATE_FAILED`、`SSE_CONNECTION_ERROR`、`PROVIDER_NOT_READY`、`PROVIDER_PROFILE_IN_USE`、`PROVIDER_BROWSER_START_FAILED`、`PROVIDER_PAGE_CLOSED`、`PROVIDER_BROWSER_CRASHED`、`PROVIDER_NAVIGATION_FAILED`、`PROVIDER_DOM_CHANGED`、`PROVIDER_RESPONSE_TIMEOUT`、`PROVIDER_CANCELLATION_UNCONFIRMED`、`DATABASE_ERROR`、`INTERNAL_ERROR`、`BROWSER_LAUNCH_FAILED`、`BROWSER_RESTART_FAILED` |
| `502` | `PROVIDER_ATTACHMENT_FAILED` |
| `503` | `ATTACHMENT_CAPACITY_EXCEEDED` |
| `504` | `BROWSER_RESTART_TIMEOUT`、`PROVIDER_ATTACHMENT_TIMEOUT` |

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
| `PROVIDER_LOGIN_REQUIRED`（401 / status `LOGIN_REQUIRED`） | Gemini 未登录或登录态失效 | ① 停止占用同一 profile 的 Backend → ② `yarn browser:login` → ③ 人工完成登录 → ④ CLI 成功退出后重启 Backend → ⑤ `GET /api/browser/status` 确认 `providerLoggedIn=true`。**系统不会自动完成 Google 登录**（见 [§8](#8-首次-gemini-登录)） |
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
- `AUTH_PASSWORD` / `AUTH_SESSION_SECRET`（[§26](#26-访问鉴权sec-1)）
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

## 25. V1.1 模型选择（Gemini Web）

V1.1 在不改变 V1 请求链路语义的前提下新增会话级模型选择，全部基于 Gemini Web 动态目录，无任何静态模型配置：

- **请求链路定位**：NextChat Frontend → 本 Backend（REST / SSE）→ Playwright Chromium → Gemini Web；不使用 Gemini API；当前为单用户、单 Backend 实例的自托管方案。
- **模型目录**：`GET /api/provider/models`，由 Provider 页面实时读取（`listModels()`）。仅 `READY` 可用；`LOGIN_REQUIRED` → `401 PROVIDER_LOGIN_REQUIRED`，其余非 READY 状态 → `500 PROVIDER_NOT_READY`。
- **三层模型字段**：
  - `Conversation.preferredModelKey` —— 会话模型偏好，经 `PATCH /api/conversations/:id` 保存（显式 `null` = 恢复默认模型）；
  - `Request.requestedModelKey` —— Request 创建时冻结的快照（`body.modelKey ?? 会话偏好 ?? null`），后续偏好修改不影响在途请求；
  - `Request.resolvedModelKey / resolvedModelLabel` —— 执行时 `ensureModel()` 确认成功的模型，在发送 Prompt 前落库。
- **执行链路**：Scheduler 认领 → `ensureModel`（目录校验 → 菜单切换 → 重验选中）→ resolved 落库 → `runPrompt`。切换失败（`PROVIDER_MODEL_UNAVAILABLE` / `PROVIDER_MODEL_SWITCH_FAILED`）Request 一律 `FAILED`，**Prompt 不发送**。
- **默认模型兼容路径**：`preferredModelKey=null` 且 body 不带 `modelKey` → `requestedModelKey=null` → **完全不调用 `ensureModel`**（0 次模型菜单 DOM），resolved 字段保持 `null`，行为与 V1 冻结基线一致。
- **模型键语义**：模型 key 是 Gemini Web 菜单的不透明 `data-mode-id`，**禁止硬编码**，不保证跨账号 / 跨会话稳定；历史偏好键不在当前目录时不会被自动清除，执行时判 `PROVIDER_MODEL_UNAVAILABLE`。
- **Provider Page 互斥（ProviderPageLock）**：Scheduler 执行（openGemini / ensureModel / runPrompt）与 `GET /api/provider/models`（listModels）共用同一把 Page 锁，同一时刻至多一个操作进入 Gemini 页面，锁被占用时 `listModels` 立即返回 `PROVIDER_NOT_READY`；叠加 Scheduler 全局并发 = 1，模型操作与对话执行永不并发。
- **幂等**：会话偏好不参与请求指纹（`modelKey` 显式携带时参与）；同 Key 同内容重试不受偏好变化影响。

---

> 本 README 以 V1 冻结 commit `4dfb074a48f236b2b3fa20dc7fe88d4e562ff073` 的源码为基础编写；V1.1 模型选择章节对应 commit `c588c8d`（M4 收口）；V1.2 图片上传功能冻结基线：Backend `0676f18` / Frontend `7974e524`（详见 [docs/RELEASE_NOTES_V1.2.md](docs/RELEASE_NOTES_V1.2.md)）。若文档与源码冲突，以对应 commit 的源码为准。

---

## 26. 访问鉴权（SEC-1）

服务端鉴权（设计唯一来源：[docs/SEC1_AUTH_DESIGN.md](docs/SEC1_AUTH_DESIGN.md)）：Shared Password + 无状态 HMAC Session Cookie，零新依赖（无 Session 表 / Redis / JWT 库），Prisma Schema 零改动。

**端点（始终挂载；`AUTH_ENABLED=false` 时进入 disabled 模式，恒返回 `authenticated: true`）：**

| 端点 | 行为 |
| --- | --- |
| `POST /api/auth/login` | body `{ password }`；成功 200 并 Set-Cookie，密码错 401 `AUTH_INVALID_CREDENTIALS`，限流 429 `AUTH_RATE_LIMITED`（带 `Retry-After`） |
| `GET /api/auth/session` | 永不 401；返回 `{ authenticated, expiresAt }`，认证状态每次读 Backend 当前事实 |
| `POST /api/auth/logout` | 幂等 204，`Max-Age=0` 清除 Session Cookie |

三个端点响应统一携带 `Cache-Control: no-store`。`AUTH_ENABLED=true` 时，除 Health 外的全部 `/api/*` 经 `requireAuth` 保护，未认证统一 401 `AUTH_REQUIRED`。

**环境变量（`AUTH_ENABLED=true` 时 fail-fast 校验）：**

| 变量 | 说明 |
| --- | --- |
| `AUTH_ENABLED` | 默认 `false`；`NODE_ENV=production` 时必须为 `true`（拒绝无鉴权上线） |
| `AUTH_PASSWORD` | 开启时必填，min 12 字符；sha256 后恒定时间比较，不落日志 |
| `AUTH_SESSION_SECRET` | 开启时必填，≥32 字符；推荐 `openssl rand -hex 32`；HMAC-SHA256 签名密钥 |
| `AUTH_SESSION_TTL_SECONDS` | Session 有效期，默认 604800（7 天），范围 300~2592000 |
| `AUTH_TRUST_PROXY` | 默认 `false`；只影响 `req.ip`（登录限流键），**不**影响 Cookie Secure |
| `AUTH_ALLOWED_ORIGINS` | 逗号分隔 Origin 白名单；production + 开启时必填且每项必须 https |

**Cookie 与 CSRF**：`personchat_session` = `base64url(payload).base64url(HMAC)`，payload 为 `{v,iat,exp,sid}` 紧凑 JSON；属性恒 `HttpOnly` + `SameSite=Strict` + `Path=/`，production 恒 `Secure`（dev http 场景无 `Secure` 属预期）。CSRF 防线 = SameSite=Strict + unsafe method（POST/PUT/PATCH/DELETE）Origin 白名单校验，无 Origin 头（curl/supertest）放行，`Origin: null` 或非法 Origin → 403 `AUTH_CSRF_REJECTED`；禁止通配与子串匹配。

**登录限流**：仅 login 端点；进程内 fixed window（5 次失败 / 10 分钟）按 `req.ip` 分桶；只计密码错误（400 不计、成功清零）；触发返回 429 + `Retry-After`。`AUTH_TRUST_PROXY=false`（默认）时键 = socket remoteAddress——防伪造的安全 fallback；公网部署且全部流量经同一本地代理时退化为全局共享桶（可用性限制，非安全问题）。`AUTH_TRUST_PROXY=true` 仅在真实反向代理覆盖/清洗 XFF 的部署中评估，且启用前必须重测限流键解析与伪造 XFF 两项验收（对应实施报告 REAL-09A/09B）。

**Session 吊销**：无状态设计无在线撤销列表；**全局吊销 = 轮换 `AUTH_SESSION_SECRET` 并重启**（全部旧 Cookie 立即失效）；单设备登出 = `POST /api/auth/logout`。

**前端配套**（front 仓库）：AuthGate 登录门 + `useAuthStore` 状态机（probe/login/logout/markUnauthorized）；业务 API 401 `AUTH_REQUIRED` 与 SSE 探测失效统一触发全局登出并关闭活跃 SSE（后端 Request 不取消，继续执行落库）。
