# BASELINE_REPORT.md

> NextChat 基座检查报告(第 0 阶段输出)
>
> 检查日期:2026-09-02
>
> 检查方式:只读,未修改任何代码、未安装/升级依赖
>
> 依据设计文档:prd.md(V2)第 0 阶段

---

# 1. 结论摘要

| 项 | 结论 |
| --- | --- |
| Node.js | v24.14.0 |
| 包管理器 | yarn 1.22.19(唯一,yarn.lock) |
| NextChat fork | front/,git HEAD `defdcdb5`,显示版本 v2.16.1(来自 tauri.conf.json) |
| 前端核心版本 | Next.js 14.1.1 / React 18.2.0 / TypeScript 5.2.2 / zustand 4.3.8 |
| Conversation 存储 | 浏览器 IndexedDB,key = `chat-next-web-store`(localStorage 仅兜底) |
| Message 存储 | 同上(session.messages 内嵌) |
| 架构 | 单页 + HashRouter;浏览器 → Next.js 同源代理 `/api/[provider]/...` → 真实 Provider |
| 第 1 阶段 | **可以开始**(不主动升级 NextChat 核心依赖) |

---

# 2. 环境

```text
node -v      → v24.14.0
npm -v       → 11.9.0   (未使用)
yarn -v      → 1.22.19
pnpm         → 未安装
```

注意:实际 Node 为 v24.14.0(24 LTS 线),不是 22。满足后端核心依赖要求。

建议后续在 back/server 增加 `.nvmrc` 锁定 Node 24 主版本。

---

# 3. 包管理器

```text
package.json packageManager → yarn@1.22.19
lockfile                     → 仅 yarn.lock(无冲突)
```

结论:前端唯一包管理器 = yarn 1.22.19。后端尽量使用同一种。

---

# 4. Git

## front(NextChat fork)

```text
remote   → https://github.com/hukaiedu/NextChatfront.git
branch   → main
HEAD     → defdcdb5 (Merge pull request #6869 from ChatGPTNextWeb/Leizhenpeng-patch-8)
提交数   → 3139
tag      → 无
工作树   → 干净
```

## back(本项目后端目录)

```text
全新空 git 仓库(分支 master,无提交),当前仅含 prd.md
```

---

# 5. 版本

- NextChat 显示版本 `v2.16.1`:来源 `src-tauri/tauri.conf.json` 的 `package.version`,由 `app/config/build.ts:8` 拼成 `"v" + version`
- front 的 `package.json` 没有 `version` 字段
- 已装真实版本(node_modules 实测):next 14.1.1、react 18.2.0、react-dom 18.2.0、zustand 4.3.8
- 声明的 TypeScript(dev):5.2.2

核心前端依赖(package.json 均为 `^x` 范围,实际由 yarn.lock 固定,已装版本如上):

```json
"next": "^14.1.1",
"react": "^18.2.0",
"react-dom": "^18.2.0",
"zustand": "^4.3.8",
"idb-keyval": "^6.2.1",
"react-markdown": "^8.0.7",
"mermaid": "^10.6.1",
"@fortaine/fetch-event-source": "^3.0.6",
"axios": "^1.7.5",
"@hello-pangea/dnd": "^16.5.0"
```

第一版原则:不主动升级 NextChat 核心依赖。

---

# 6. 真实目录结构

front 不是"目录即路由":`app/` 下只有单页入口 `app/page.tsx`,全部"页面"是 HashRouter 伪路由(定义于 `app/components/home.tsx:179-205`)。

```text
front/
├── app/
│   ├── page.tsx                  # 唯一真实路由页 → 渲染 <Home/>
│   ├── layout.tsx                # 全局样式引入
│   ├── components/               # home/chat/chat-list/sidebar/settings/markdown/exporter/...
│   │   └── chat.tsx              # ★ 主聊天文件(~2165 行),几乎所有聊天 UI
│   ├── store/                    # zustand stores(chat/config/access/mask/prompt/sync/...)
│   ├── client/
│   │   ├── api.ts                # ClientApi 工厂(getClientApi)
│   │   ├── controller.ts         # ChatControllerPool(abort)
│   │   └── platforms/            # openai/google/anthropic/... 每平台一个 LLMApi 类
│   ├── api/                      # 扁平 handler + [provider]/[...path] 网关
│   ├── config/                   # build.ts / client.ts / server.ts
│   ├── utils/                    # store.ts / indexedDB-storage.ts / chat.ts / hooks.ts
│   ├── lib/ locales/ masks/ mcp/ icons/ styles/ typing.ts constant.ts
├── public/
├── src-tauri/                    # 桌面壳(tauri)
├── next.config.mjs
├── package.json / yarn.lock
```

fork 特有(上游 NextChat 没有):MCP(`app/mcp/`)、Stable Diffusion(`app/components/sd/`、`app/store/sd.ts`)、Artifacts(`app/components/artifacts.tsx`、`app/api/artifacts/`)、声纹(`app/components/voice-print/`)、realtime 聊天、本地聊天全文搜索(`app/components/search-chat.tsx`)。

---

# 7. Chat 页面入口

```text
app/page.tsx:7-17                 → <Home/>
app/components/home.tsx:267-269   → HashRouter + Screen
app/components/home.tsx:196-205   → 路由表:Home/Chat/NewChat/Masks/Plugins/SearchChat/Settings/McpMarket/artifacts/:id
app/components/chat.tsx:2167      → Chat(export,key 壳)
app/components/chat.tsx:989-2165  → _Chat 真实聊天窗口
app/components/chat.tsx:494-849   → ChatActions 顶栏
```

---

# 8. Conversation / Message 存储位置(核心结论)

**当前 Conversation 和 Message 的唯一可信来源 = 浏览器 IndexedDB。**

- 持久化由 zustand persist 中间件自动完成(每次 `set()` 全量重写)
- 存储适配器:`app/utils/indexedDB-storage.ts`(idb-keyval),由 `app/utils/store.ts:37` 强制指定给全部 persist store
- 数据 key 枚举:`app/constant.ts:90-101`(`StoreKey`);聊天数据 key = **`chat-next-web-store`**
- 数据结构:zustand persist 包裹 `{ state: { sessions, currentSessionIndex, lastInput }, version }`
- `ChatSession` / `ChatMessage` 类型:定义在 `app/store/chat.ts:57-96`(无独立类型文件)
- state 形状:`{ sessions: ChatSession[], currentSessionIndex, lastInput }`,`chat.ts:226-230`

```text
ChatSession {
  id, topic, memoryPrompt,
  messages: ChatMessage[],     # ← Message 存在会话内部
  stat, lastUpdate, mask, ...
}

ChatMessage {
  id(nanoid), date, role,
  content,
  streaming, isError, model, tools, audio_url ...
}
```

## LocalStorage / IndexedDB 使用情况

| 项 | 结论 |
| --- | --- |
| IndexedDB | 主存储,key=`chat-next-web-store` 等(经 idb-keyval 的 `keyval-store` 库) |
| localStorage | 仅兜底:IDB 为空/抛错时读取、写入失败时回写(`indexedDB-storage.ts:8-15,26`) |
| localStorage 散用 | 界面语言(`locales/index.ts:91-95`);未发送草稿 key=`unfinished-input-<sessionId>`(`chat.tsx:1495-1510`) |
| hydrate | 无手动 bootstrap;store 首次使用时 persist 自动 rehydrate |
| 删库 | 设置页"清空":`indexedDBStorage.clear()` + `localStorage.clear()` + reload(`chat.tsx:815-819`) |

**对改造的意义**:拦截点 = 替换/截断 `app/utils/indexedDB-storage.ts` 导出的 storage 适配器,或改造 `store/chat.ts` 的 `updateTargetSession/deleteSession` 及流式回调,使数据走后端 API。

---

# 9. 消息发送完整调用链

默认 OpenAI、Web 模式、流式:

```text
发送按钮 onClick                          app/components/chat.tsx:2124
→ doSubmit(userInput)                    app/components/chat.tsx:1105
→ chatStore.onUserInput(userInput, imgs) app/store/chat.ts:407
     ├─ getMessagesWithMemory()          app/store/chat.ts:542   ← system/memory/context/最近N条 组装
     │                                   (系统提示注入 gpt-/chatgpt- 才启用,chat.ts:553-588)
     └─ getClientApi(providerName)       app/client/api.ts:368  → ChatGPTApi(默认 OpenAI)
         → api.llm.chat({...})           app/store/chat.ts:461
             → ChatGPTApi.chat()         app/client/platforms/openai.ts:186
                 ├─ new AbortController  openai.ts:271 → onController → ChatControllerPool.addController(store/chat.ts:521)
                 ├─ 组装 RequestPayload  openai.ts:230-240(messages/stream/model/temperature)
                 ├─ path()               openai.ts:302-304 → "/api/openai" + "/v1/chat/completions"
                 └─ streamWithThink()    openai.ts:314 → utils/chat.ts:392
                     → fetchEventSource POST /api/openai/v1/chat/completions   utils/chat.ts:545
[Next.js 服务端]
app/api/[provider]/[...path]/route.ts:63 → openai handler
app/api/openai.ts:29-78                  → auth 检查(openai.ts:54)
app/api/common.ts requestOpenai          → fetch(BASE_URL || https://api.openai.com + /v1/chat/completions)
                                                                                          common.ts:147
                                           → 流式 body 原样透传回浏览器                 common.ts:178-182
[浏览器]
fetchEventSource onmessage 解析 SSE 增量   utils/chat.ts:586-620
→ onUpdate/onFinish 写回 botMessage       store/chat.ts:464-481
```

键盘提交另一入口:`onKeyDown`(`chat.tsx:2085`)→ `onInputKeyDown`(`:1178-1193`)→ `doSubmit`。

---

# 10. Provider 完整调用链

## 客户端工厂

`app/client/api.ts`:`ClientApi` 按 `ModelProvider` 选 LLMApi 类(`:136-183`),`getClientApi(ServiceProvider)`(`:368-399`)。

平台类(`app/client/platforms/`):openai(ChatGPTApi,兼 Azure)、google(GeminiProApi)、anthropic、baidu、bytedance、alibaba、tencent、moonshot、iflytek、deepseek、xai、glm、siliconflow、ai302。

## 服务端代理

`app/api/[provider]/[...path]/route.ts`(GET/POST,edge)按 `/api/{provider}` 分发到扁平 handler:

```text
app/api/openai.ts / azure.ts / google.ts / anthropic.ts / baidu.ts / bytedance.ts /
         alibaba.ts / moonshot.ts / iflytek.ts / deepseek.ts / xai.ts / glm.ts /
         siliconflow.ts / 302ai.ts / stability.ts / proxy.ts / auth.ts / common.ts
```

真实路由(非 handler):`api/tencent/route.ts`、`api/config/route.ts`、`api/artifacts/route.ts`、`api/upstash/[...]/route.ts`、`api/webdav/[...]/route.ts`。

## Gemini 在本 fork 中的位置

- 没有名为 "Gemini" 的 provider;是 `ServiceProvider.Google`(`constant.ts:123`)+ `ModelProvider.GeminiPro`(`:151`)
- 客户端:`GeminiProApi`,`client/platforms/google.ts`(流式 URL 加 `?alt=sse`,`:54-59`);服务端:`api/google.ts`
- 模型表 `googleModels`:`constant.ts:544-565`(gemini-1.5/2.0/2.5 系)

注意:它是真实 **Gemini API** 调用,与本项目要做的 Gemini **网页**自动化(Playwright)无关。改造时绕开,不复用。

## 请求头

`getHeaders()`:`app/client/api.ts:244-366`。按 providerName 从 access store 取 key,填 `Authorization`/`x-api-key`/`x-goog-api-key`/`api-key`;无 key 且有 access code 时 `Authorization: Bearer nk-<code>`。

## 已有自定义 endpoint 能力

- `BASE_URL` 环境变量覆盖服务端出网目标(`config/server.ts:184`,消费于 `common.ts:32-37`)
- 通用兜底代理 `app/api/proxy.ts`(请求头 `x-base-url` 指定目标)
- 用户自定义 endpoint(`store/access.ts:66-85`)
- next.config.mjs 对 `/api/:path*` 加宽 CORS + rewrites

---

# 11. Markdown 实现位置

全部集中在 `app/components/markdown.tsx`:

```text
import ReactMarkdown       markdown.tsx:1
remarkPlugins              math/gfm/breaks                          markdown.tsx:277-287
rehypePlugins              katex / rehype-highlight                 markdown.tsx:277-287
components 覆盖             pre: PreCode(复制按钮), code: CustomCode markdown.tsx:74, 288-290
mermaid                    markdown.tsx:10,32-34,61,85-90,148-149
调用处                     app/components/chat.tsx:1970-1987(传 fontSize/fontFamily/loading)
```

结论:Markdown 渲染保留复用,无需改造。

---

# 12. Conversation List 实现位置

```text
app/components/chat-list.tsx      ChatList 105-174;ChatItem 23-103;拖拽 dnd 135-172
                                 删除按钮 89-98 → onDelete → chatStore.deleteSession 156-163
app/components/sidebar.tsx       侧栏壳;新建会话 353-359;删除全部 322-324;设置入口 331-334
app/store/chat.ts:337-378        deleteSession(带 5s 撤销 Toast)
```

会话级"导出/分享"按钮在聊天窗口头部 `chat.tsx:1738-1747` → exporter 对话框(`app/components/exporter.tsx`)。

---

# 13. Settings 实现位置

```text
伪路由 /settings               constant.ts:47;dynamic import home.tsx:47-49;注册 home.tsx:203
页面组件                      app/components/settings.tsx:584(Settings)
各平台 Endpoint/Key 配置      settings.tsx:638-1000+
主题/字号                    settings.tsx:1606-1608, 1641-1654
customModels/ModelConfigList settings.tsx:1818-1919
配置存储                     zustand persist(utils/store.ts);key = StoreKey.Config
```

---

# 14. 模型切换实现位置

```text
切模型按钮+弹层        app/components/chat.tsx:676-693(值 = "model@providerName")
DALL-E3 size/quality   chat.tsx:744-796
数据源                 useAllModels(): app/utils/hooks.ts:5-22
模型默认表             app/constant.ts:746(DEFAULT_MODELS)
启动拉取模型列表        home.tsx:230-231 api.llm.models()
模型参数编辑器          app/components/model-config.tsx:12(ModelConfigList)
默认模型               session.mask.modelConfig: model=gpt-4o-mini, providerName=OpenAI(store/config.ts:66-68)
```

---

# 15. 文件上传实现位置

只有图片上传,无通用文件上传:

```text
上传按钮           chat.tsx:624-630(仅 isVisionModel 时显示,chat.tsx:572-578)
handler           chat.tsx:1555-1598;粘贴图片 chat.tsx:1512-1553;最多 3 张 :1544-1546
accept            白名单:image/png, image/jpeg, image/webp, image/heic, image/heif
压缩               app/utils/chat.ts:15-71,144-165 → base64 ≤256KB(HEIC 经 heic2any 转 jpeg)
```

---

# 16. Regenerate 实现位置

```text
按钮      chat.tsx:1888-1892(Retry ChatAction)→ onResend(message)
逻辑      chat.tsx:1217-1271:删除配对 user/assistant 消息(:1224-1263)→ onUserInput 重发(:1269)
```

---

# 17. Stop Generate 实现位置

```text
停止按钮        chat.tsx:1878-1885 → onUserStop chat.tsx:1144-1146
控制器池        app/client/controller.ts:ChatControllerPool.addController/stop/stopAll(5-23)
abort 实现      平台类内 new AbortController(openai.ts:271);signal.onabort = finish(utils/chat.ts:298,524)
超时            REQUEST_TIMEOUT_MS=60s(constant.ts:115;utils/chat.ts:315-318,541-544)
```

本质:**前端中止 fetch 流**,没有后端语义。改造时需接 Request Cancel 的后端流程。

---

# 18. 可以直接复用的功能

```text
Markdown / 代码高亮 / mermaid 渲染     app/components/markdown.tsx
聊天 UI 全套(列表/输入/气泡/流式 loading)  app/components/chat.tsx
SSE 流式消费(fetch-event-source + streaming 状态机)
导出会话(markdown/json/图片)          app/components/exporter.tsx
主题/字号/UI 设置                       settings + store/config
Stop/Abort controller 池机制           client/controller.ts(可改接到 Request Cancel)
会话删除/撤销、本地聊天搜索            chat-list / search-chat
```

---

# 19. 必须绕开的功能

```text
浏览器本地持久化(IndexedDB chat-next-web-store + localStorage 兜底) → 后端数据库为准
原 Provider 出网链(前端 platforms + api/[provider] 网关 + rewrites/代理) → 业务请求走我们的 back
分享到 sharegpt.com(消息离开本机)      exporter.tsx:357-362 → client/api.ts:191-228
云同步 WebDAV/Upstash 整包备份          store/sync.ts(可选,保留但非业务来源)
fork 特有功能:MCP / SD / Artifacts / realtime / 声纹(本期不接,入口侧栏已有)
```

---

# 20. 必须隐藏的功能

```text
模型切换(第一版隐藏)
API Key / Endpoint 设置(settings 中的 provider 配置区块)
图片上传按钮与图片能力(第一版隐藏)
绘图功能(DALL-E / Stable Diffusion 入口)
Regenerate(第一版关闭)
```

---

# 21. 后续实际需要修改的文件

> 第 0 阶段完成后的准确路径。改造前仍需以第 7 阶段时的真实代码为准。

| 文件 | 改动 |
| --- | --- |
| `app/store/chat.ts` | 核心:数据读写改走后端 API;发送/停止/重发流程接入 Request/SSE 语义 |
| `app/components/chat.tsx` | 发送/停止按钮接后端;隐藏图片/regenerate;错误态展示 errorCode |
| `app/client/api.ts`、`app/client/platforms/`(新增) | 新增指向我们 back 的客户端(或直接替换调用链) |
| `app/components/chat-list.tsx`、`sidebar.tsx` | 会话列表接 Conversation API;新增归档 UI(fork 无归档) |
| `app/components/settings.tsx` | 隐藏 API Key/模型相关设置 |
| `app/store/config.ts`、`app/store/access.ts` | 配置来源调整(access 不再管业务 key) |
| `app/utils/indexedDB-storage.ts`、`app/utils/store.ts` | 截断/关闭本地持久化(或保留 UI 层状态、数据走后端) |
| `app/components/markdown.tsx` | 基本不动(复用) |
| `app/components/exporter.tsx` | 保留(导出) |

---

# 22. 与设计文档的差异

1. **存储主力是 IndexedDB,不是 localStorage**。本 fork 将上游 localStorage 全局替换为 idb-keyval;localStorage 同名 key 只是降级兜底。设计文档功能兼容表的 "LocalStorage 会话/IndexedDB 会话" 两条均命中,统一处理:禁止作为业务可信来源。
2. **Node 实测 v24.14.0**(24 LTS 线),文档写"优先 22 LTS"。高于 22,满足后端核心依赖要求,记录实测值,建议 `.nvmrc` 锁 24。
3. **Gemini 在本 fork 是 Google provider(Gemini API 调用)**。与第 4 阶段的 Gemini 网页自动化不同,互不影响;UI 层保留,Provider 层绕开。
4. **fork 与上游结构差异大**:chat.tsx 单文件约 2100 行、带大量上游没有的功能(MCP/SD/Artifacts/realtime/声纹/search-chat)→ 属文档"情况 3",只影响第 7 阶段修改文件集合,不改变总体架构。
5. **没有归档(archive)概念**(全仓库无命中)。归档/恢复 = 新增状态 + UI + 后端 API。
6. 显示版本号机制特殊:package.json 无 version;显示版本来自 src-tauri/tauri.conf.json。
7. 无联网 web search;"SearchChat" 只是本地会话全文搜索(逐消息 substring)。
8. 消息级 Pin 是把消息复制进 mask.context 作为上下文,不是会话置顶;会话列表本身无置顶/分享按钮(分享=导出/云端)。
9. 上传无独立后端端点,纯本地压缩 base64(≤256KB);设置页"清空"是 IDB+localStorage 全清。

---

# 23. 第 1 阶段是否可以开始

**可以。**

```text
1. 两个核心问题已实证回答:发送调用链完整清楚(第 9 节),数据存储位置清楚(第 8 节)
2. 环境就绪:Node v24.14.0、yarn 1.22.19、仅 yarn.lock 无冲突
3. 前端改造路径已确定(第 21 节),不阻塞后端独立开发
4. back 为干净空仓库,可直接创建 server/
5. 不升级 NextChat 核心依赖
```

---

# 附:检查命令留档(只读)

```powershell
node -v
git -C ..\front rev-parse HEAD
git -C ..\front branch --show-current
git -C ..\front remote -v
Get-Content ..\front\package.json
Get-ChildItem ..\front\package-lock.json,..\front\yarn.lock,..\front\pnpm-lock.yaml -ErrorAction SilentlyContinue
git -C ..\front grep -n "chat-next-web-store"
git -C ..\front grep -n "idb-keyval"
git -C ..\front grep -n "fetchEventSource"
```
