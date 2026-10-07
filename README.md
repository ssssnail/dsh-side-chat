# 临时会话（side chat）

A DSH plugin that adds a temporary, read-only discussion panel beside the running
session: an independent context snapshot, multi-turn streaming answers, its own
model switch, and nothing kept after closing.

Entry point: the composer toolbar, next to the model selector.
Panel: a right-sidebar tab named **临时会话**.

```
composer entry ──opens──▶ sidebar.right tab "临时讨论" ──HTTP+SSE──▶ host runtime ──▶ ctx.llm.stream
      │                                                                     ▲
      └── inputActions.setDraft() ◀── "放入主会话草稿" ── panel ────────────┘
```

## Architecture (Route A)

A discussion is a **real in-memory Session** driven with **real events**, so the
harness's own Conversation, chat, usage and reasoning components can render it —
not a hand-copied imitation.

| Piece | How |
|---|---|
| The Session | `ctx.sessions.prepare` → `enter` → `announce`. Created **outside** the agent lifecycle, which the session store documents as persisting nothing: no log writer is ever attached. `enter` returns the detach disposer that `close` calls, so closing destroys it. |
| The inherited prefix | The parent's own events are **seeded** into the Session (`snapshotEvents(firstKept, boundary + 1)`), so `session.deriveMessages()` reproduces the parent prefix without re-serialising it. |
| The discussion instruction | One `developer/message` event appended inside the first turn, i.e. after the inherited prefix. |
| A turn | `turn/start` → `developer/message` (first turn only) → `user/message` → per model step: `step/start`, `request/header` (on change), `assistant/message` (with durable `stream` records and `usage`), `tool/call`, `tool/result` → `turn/end` with `completed`/`aborted`/`error`. |
| Live streaming | `ctx.emit('agent/assistant-stream', { frame })` with the loop's own frame protocol — `{type:'start'\|'chunk'\|'end', attemptId, revision, index, turn, step, chunk}` and `{kind:'committed'\|'abandoned'}` outcomes. The client turns these into `assistant/live-chunk`. |
| Unanswered calls | A turn can stop between an assistant tool call and its result (user stop, round cap, a refusal). The result is closed with a synthetic `tool/result` **in the log**, because a provider rejects a history that ends with an unresolved call. |

`ctx.llm.stream` is still called **without `sessionId`**, so the harness's
session-scoped `llm/stream` listeners (checkpoint policy, title) stay untouched.

## What it does

| Behaviour | Where |
|---|---|
| Fixed entry next to the model selector | `client.js` → slot `conversation.input.left` |
| One panel per session, re-click focuses it | `client.js` → `ctx.sidebarRight.openTab('side-chat')` (page tabs deduplicate) |
| Snapshot of the main session, cut at the last **completed** turn | `host/snapshot.js` |
| Multi-turn streaming answers, own stop button | `host/runtime.js` + `client.js` (SSE) |
| Read-only file tools (`read` / `glob` / `grep`), workspace-confined | `host/readonly-tools.js` |
| Model inherited at open, switchable per discussion (`/model`) | `host/runtime.js` → `ctx.llm.stream` |
| `/compact` compresses only the discussion's own history | `host/runtime.js` → `compact()` |
| Unavailable commands greyed out with a reason | `client.js` → `UNAVAILABLE_COMMANDS` |
| Close confirmation, then destroy | `client.js` → `renderCloseDialog`, `host/runtime.js` → `close()` |
| Selected turn into the main draft (never auto-sent) | `client.js` → `inputActions.setDraft()` |
| Cache/token statistics per request, no content logged | `host/runtime.js` → `stats`, `absorbUsage` |

## Guarantees (structural, not prompt-based)

- **No Session is created.** The discussion never touches `ctx.sessions.create`,
  the agent loop, or the session log. The snapshot *reads* the parent Session.
- **Nothing is persisted.** No JSONL, no directory index, no search, no browser
  storage, no diagnostics of message bodies. A page refresh loses the panel
  because its state is a module-scope object.
- **Read-only by construction.** The model is offered three tools; the
  dispatcher refuses every other name before any handler exists, and every path
  is resolved and containment-checked against the bound workspace (a symlink out
  is rejected because resolution is realpath-derived).
- **The main session is not perturbed.** `ctx.llm.stream` is called *without*
  `sessionId`, which is exactly the condition under which the harness's
  session-scoped `llm/stream` listeners (checkpoint policy, session title) return
  `next()` untouched.
- **Prefix reuse is preserved where it is free.** The inherited messages are the
  parent's own derived request messages, roles and block boundaries unchanged;
  the discussion instruction is appended *after* them, so the head of the request
  is not rewritten. Trimming to fit the window only happens when the budget
  requires it, and is reported to the user as “已使用部分上下文”.

## Deviations from the design document, and why

The document describes a feature built *inside* dsh. This is a plugin installed
through Plugin Manager, so some parts have no reachable extension point:

| Document | Here | Reason |
|---|---|---|
| In-memory `Session` creation path inside `dsh-agent-loop` | direct `ctx.llm.stream` calls with a constructed message array | `agentLoop.create()` always attaches the storage handle; the “memory create” branch is inside the shipped package. The direct call is also *stronger*: nothing to skip. |
| `discussion.open/send/...` RPC | plugin-owned HTTP + SSE route `/side-chat/*`, token injected into the page | an installed bundle's Client half cannot reach a runtime-registered Remote namespace (the application's Remote set is fixed at build time). |
| Reuse of the main `/` command catalog | a local command menu with the same vocabulary, unavailable entries greyed out with reasons | the command menu is bound to the Agent and its scoped input machine; a slot component cannot drive it. |
| `/plan`, `/file`, `/permission`, `/goal` in the panel | listed and refused with an explanation | same reason; the refusal is honest rather than a silent fallback to the model. |
| Tool *declarations* kept while only read tools are callable | the three read-only declarations are sent, nothing else | an installed plugin cannot present the main session's tool block and then restrict the callable set through the provider. |
| Connection-bound instance ownership | per-process token + `pagehide` beacon + close-on-stream-abort + idle sweeper | the plugin cannot subscribe to the transport's connection lifecycle. |
| Panel focus returns to the composer | not implemented | `InputActions` exposes no `focus()`; only the internal `SessionInput` face has it. |

Everything else in the document — the confirmation copy, the excerpt format, the
“state of a stopped answer”, the greying rules, the lifecycle table, the cache
statistics — is implemented as written.

## Install

```bash
# from the DSH session that should own the profile
plugin_manager install_bundle  target=/absolute/path/to/side-chat
```

The bundle declares no dependencies and runs no build scripts, so `install_bundle`
copies the package and inserts one row (`side-chat`) into the profile patch. The
Client half is served from the package's `./client` export. Disable or remove it
through Plugin Manager to revert.

## Test

```bash
npm test          # 32 hermetic checks: no network, no model, nothing installed
npm run test:real # 13 checks against the harness's own fs-local backend on real disk
```

- `test/dry-run.mjs` drives the **real host code** through the real HTTP handler:
  snapshot boundaries (the in-flight turn is excluded), a tool round, a refusal
  for a path outside the workspace, a refusal for a non-whitelisted tool, stop,
  the busy refusal, idempotent close, model listing, and the unload beacon.
- `test/client-render.mjs` renders the **real client components** against a
  minimal React hook runtime and a stubbed RPC surface: the entry opens the
  panel, the header/snapshot copy renders, a question streams an answer with tool
  rows and usage pills, answers render as markdown, three consecutive tool
  failures cancel the turn, `/goal` is refused without sending, the draft append
  preserves the existing draft, close asks first, and every locale key resolves.
- `test/real-fs.mjs` instantiates the harness's own `dsh-fs-local` service and
  runs the toolbox against the real disk: relative and absolute reads, line
  windows, refusals for absolute, traversal, escaping-symlink and spill-style
  temp paths, plus the glob/grep confinement and the non-whitelisted call.

**Why a discussion refuses paths it can see.** The inherited snapshot can name
files the main session touched outside the bound workspace — tool spill files
under the platform temp root are the common case. The toolbox refuses them by
contract (that is the workspace-confinement acceptance case), so the refusal now
says so explicitly and tells the model not to walk the rest of the list; the
turn guards stop it if it tries anyway. Reading such a file is intentionally not
possible: widening the bound would trade the guarantee for convenience.

## Files

| File | Role |
|---|---|
| `index.js` | Host plugin: token injection, HTTP/SSE route, idle sweep, teardown |
| `host/snapshot.js` | Snapshot capture, route inheritance, budget trimming |
| `host/prompt.js` | The discussion-only developer instruction and boundary marker |
| `host/readonly-tools.js` | Tool declarations, path confinement, `read`/`glob`/`grep` |
| `host/runtime.js` | Discussion instances, turn loop, cancel, compaction, statistics |
| `client.js` | Composer entry, right-sidebar panel, draft bridge, IME guard |
| `cordis.patch.yml` | The single Host row the bundle inserts |

## Operational notes

**Which model a discussion starts on.** `selectRoute` reads, in order: the
session's most recent `model/selection` event (the value the composer's model
seat displays and the one an `agent/request` listener applies to the next
request), then the last logged request header, then the process default. Only
the first source stays correct when the user switched model without sending yet.

**Changing this plugin while it is running.** The profile installs the package as
a symlink, so edits are on disk immediately, but:

- The **Client** half is re-snapshotted when the Loader entry changes — toggling
  the plugin off and on in Plugin Manager is enough, and a page refresh then
  serves the new `client.js`.
- The **Host** half is a Node ES module; toggling the plugin re-runs the *cached*
  module, so a Host-side change needs a `dsh web` restart. This profile runs HMR
  with `root: []` (configuration watches only), so module sources are not
  watched. `/side-chat/ping` reports `revision` so a running process can be told
  apart from the file on disk.

**Page refresh after installing.** The per-process token reaches the browser only
through the index document's `tapIndex` payload, so a page served before the
plugin existed cannot call the API until it is reloaded. The panel says so
rather than failing silently, and distinguishes the two ways this happens: no
token at all (the page predates the plugin) and a stale token (the plugin was
re-enabled after the page loaded). The token itself is minted once per process,
so re-enabling the plugin no longer invalidates an open page.

**Staying visually consistent with the main session.** The panel does not invent
a look: geometry, radii, type sizes, states and copy come from the host's own
stylesheets.

| Surface | Copied from |
|---|---|
| Composer card | `InputBar.module.css`: `--dsw-radius-panel`, `--dsw-specific-input-major`, `--dsw-elevation-soft`, `padding-top:8px`, `gap:12px`, tool row `padding:2px 8px 6px` |
| Input | the same sheet: `min-height:36px`, `padding:4px 8px 0 14px`, one line that grows, `--dsh-content-font-size` |
| Model control | the same sheet's `.select`: 28px, 13px/500, trailing chevron, `padding:0 20px 0 8px` |
| Submit / stop | the same sheet's `.primary`: a 34px round control in `--dsw-alias-button-info-fill`, `translateY(-2px)` |
| Usage pills (under the card) | `StatsPills.module.css`: 12px, `--dsw-alias-label-tertiary`, radius 999px, `padding:1px 8px`, tabular numerals, `·` separator — including the cache-hit percentage the main session shows |
| User turn | `MessageItem.module.css`: right-aligned `--dsw-specific-bubble`, `--dsw-radius-xl`, `padding:10px 16px` |
| Answer body | markdown rendered with the `ui-primitives` markdown typography (headings, lists, quotes, rules, fenced code with a copy banner, tables, inline code/emphasis/links) |
| Buttons elsewhere | `Button.module.css` `.sm` / `.ghost` / `.outline` |

A plugin may not import `ui-primitives`, so the markdown **renderer** is its own
(~120 lines, React elements only — never `dangerouslySetInnerHTML`); the
typography it targets is the host's. Every variable is written with a literal
fallback, so a renamed token degrades the appearance instead of breaking the
render. The panel body deliberately renders no title and no empty-state
sentence: the right-sidebar tab chip carries the name.

**A failing tool cannot become a loop.** Three guards, because the failure mode
is expensive: the server refuses an *identical* call (same name, same arguments)
that already failed in this discussion, ends a turn after two consecutive
all-failed tool rounds, and caps tool rounds per turn. The client additionally
cancels a turn after three consecutive tool failures, and each failing chip now
shows its reason inline — a tool failure is never just a red dot.


---

## 当前范围（最终，取代上面各节的历史描述）

设计目标收敛为：**只复用宿主能复用的东西，其余功能一律删掉，保留一个简单的临时会话。**

### 复用（就是宿主的原版，不是抄的）

| 能力 | 机制 |
|---|---|
| 对话正文（markdown、思考行、工具行、用量胶囊） | `conversation.content` 工厂 + `conversation.session` 视图 |
| 会话与事件 | `ctx.sessions.prepare/enter/announce`（内存、不落盘），`session.deriveMessages()` 派生请求 |
| 主会话前缀快照 | `snapshotEvents(from, boundary)` 作为 `seed` + `inheritedEventCount` |
| 标签与资源 | `ctx.resources.register` + `dsh-resource://sidechat/session/<id>` + `sidebarRightTabs` + 声明 `children:{'sidebar.chat.conversation'}` |
| 工具行、用量、缓存统计 | `tool/call` / `tool/result` / `assistant/message.usage` 事件 |

### 明确不做（宿主不支持，故不实现）

| 不做 | 原因（代码级） |
|---|---|
| 宿主 composer 组件 | 提交走 Session Controller → `ctx.agents.resume/resolve`，**必须有 Agent**。插件现在输入框是自写的。 |
| 把它塞进框架的 composer 座位 | `ConversationRoot` 的 `settling` 判定依赖客户端会话摘要（旁路会话没有条目）→ `[data-phase=settling] .composerSeat{visibility:hidden}`。 |
| `/` 命令、`/compact` | `/model` 落点是 `selectForNextRequest(agent, …)`；其余是 agent-loop 能力。 |
| harness 原版只读工具 | 工具作用域取自 **Agent** 上下文；改用自写 read/glob/grep（白名单 + realpath 边界）。 |
| 放入主会话草稿 | 需 `conversation.chat.assistant-actions`（未验证），按"简单"原则删除。 |
| 会话标题/列表/恢复 | 依赖持久化语料；本方案不落盘。 |

### 若要 100% 复用

唯一入口是 `dsh-agent-loop` 的 `createStoredSession`（`if (persistence === void 0) return undefined`，而 `createAgent` 无条件调用它）：给它一个显式的 ephemeral 分支，让讨论会话得到**真 Agent 但不落盘**。`agents.setFactory` 是单占的（第二次注册抛 `an agent factory is already registered`），所以这只能改那一个 loop，不能在插件层叠加。

### 测试

`npm test` → 宿主 14 + 客户端 7 + 真实文件系统 13 = **34 项**（全离线）。
`npm run test:live` / `SIDE_CHAT_TOOL=1 npm run test:live` → 对运行中的 profile 打真实模型调用（需要 `DSH_SESSION_ID`）。

---

## 实现形态（当前，取代上一节）

回到 **手写面板**：客户端自己渲染转录，不再依赖宿主的 Conversation。

| 部分 | 来源 |
|---|---|
| 讨论实例、内存 Session、前缀 seed、`session.deriveMessages()` 请求、只读工具、live 帧、用量统计 | 宿主半（`index.js` + `host/*`），全部是真会话真事件 |
| 转录、markdown 子集、思考行、工具行、用量胶囊、模型选择、草稿摘录、关闭确认、空状态 | 客户端面板（自己实现） |
| 样式变量与尺寸 | 逐条抄自宿主模块 `InputBar` / `MessageItem` / `StatsPills` / `ReasoningRow` 的 `.module.css` |

**为什么不能用宿主的对话 UI**（两条都是代码级定论，不是取舍）：

1. **composer**：提交走 Session Controller 的 prompt 通路（`resolve()` → 无 live agent 就 `ctx.agents.resume`），没有 Agent 就没有发送路径；无 Agent 的会话也拿不到 `setFactory`（单占，第二次注册抛 `an agent factory is already registered`）。
2. **Conversation**：客户端的 `retain()` 会 `attachOpening(manager.get(id).open())`，资源值要等这次 open 完成；旁路会话的 open 永不完成，所以 `resource.value` 恒为 undefined → 没有 `SessionProvider` → 转录永远空白（表现为一直"正在打开会话…"）。

要越过这两条，唯一入口是 `dsh-agent-loop` 的 `createStoredSession`（`if (persistence === void 0) return undefined`，而 `createAgent` 无条件调用它）——即给讨论会话一个显式的 ephemeral 分支。

**安装状态**：该插件当前**未安装**（已从 profile 卸载）。重新安装需要 pnpm，而该 profile 里 `@iniesta8888/agent-live-dsh@^0.3.5` 在配置的镜像上不存在（最高 0.3.4），会让任何安装/卸载失败；先修这个 pin 或把 profile registry 指向 npmjs 即可。

**测试**：`npm test` → 宿主 14 + 客户端 6 = 20；`node test/real-fs.mjs` → 13。`npm run test:live` / `SIDE_CHAT_TOOL=1 npm run test:live` 对运行中的 profile 打真实模型调用（需要 `DSH_SESSION_ID` 且插件已安装）。
