# 临时会话（side chat）

DSH Web 的插件：在主会话旁边开一个**只读的临时会话**。围绕主会话**已完成**的内容提问，模型只能读工作区，不写盘、不改文件、关闭即清空。

## 它做什么

- 侧栏输入框左侧的按钮打开一个右侧标签「临时会话」。
- 打开时做主会话的**快照**：取最后一次 `turn/end` 作为边界，边界之后的未完成轮次全部排除（不让对方看到半截工作）。
- 讨论在**内存里**是一个真 Session（继承主会话前缀），请求由 `session.deriveMessages()` 派生 —— 因此继承的那段请求前缀可以被模型服务缓存复用。
- 只读工具 `read` / `glob` / `grep`，工作区受限（realpath 校验 + 沙箱），出界与未开放的工具会被**礼貌拒绝并结束本轮**，不会反复尝试。
- 回答逐字流式；每轮带用量胶囊（缓存命中率、输入/输出、首字与总耗时，可点开明细）。可切换模型、把回答放进主会话草稿、随时停止。
- 关闭需要确认；关闭后讨论实例被销毁，磁盘上不留任何东西。

## 架构

| 半边 | 文件 | 职责 |
|---|---|---|
| 宿主 | `index.js` | 路由 `/side-chat/*`：`open` `send` `cancel` `close` `model` `models` `compact` `ping`；空闲实例回收 |
| 宿主 | `host/snapshot.js` | 主会话快照：边界、投影、预算裁剪、模型路由继承 |
| 宿主 | `host/runtime.js` | 讨论运行时：内存 Session、真实事件、逐字流、回合与拒绝策略 |
| 宿主 | `host/readonly-tools.js` | 只读工具箱：白名单、realpath 边界、拒绝分类 |
| 宿主 | `host/prompt.js` | 讨论指令与边界标记 |
| 客户端 | `client.js` | 入口按钮、面板、转录、markdown 子集、思考行、工具行、用量胶囊、模型选择、草稿摘录、关闭确认 |

样式变量与尺寸逐条抄自宿主模块 `InputBar` / `MessageItem` / `StatsPills` / `ReasoningRow` 的 `.module.css`。

### 为什么客户端自己渲染转录

两条都是代码级定论，不是取舍：

1. **composer 不可用**：宿主的输入框提交走 Session Controller 的 prompt 通路（`resolve()` → 没有 live agent 就 `ctx.agents.resume`），**没有 Agent 就没有发送路径**。而讨论会话不可能有 Agent：`agentLoop.createAgent()` 无条件调用 `createStoredSession()` 落盘（`if (persistence === void 0) return undefined` 是唯一逃生口），且 `ctx.agents.setFactory` 是单占的（第二次注册抛 `an agent factory is already registered`），插件无法叠加。
2. **Conversation 不可用**：客户端的 `retain()` 会 `attachOpening(manager.get(id).open())`，资源值要等这次 `open()` 完成；旁路创建的会话这次 open 永不完成，于是 `resource.value` 恒为 undefined、没有 `SessionProvider`、转录永远空白（表现为一直「正在打开会话…」）。

要越过这两条，唯一入口是给 `dsh-agent-loop` 的 `createStoredSession` 一个显式的 ephemeral 分支（即设计文档里的「讨论内存创建路径」）。本插件选择不动本机安装包，因此承认这条边界。

## 保证（结构性，不靠提示词）

- **不落盘**：会话通过 `ctx.sessions.prepare/enter/announce` 在内存建立，不走 `agentLoop`；`~/.dsh/sessions` 下不会出现讨论会话文件（已实测）。
- **不写工作区**：只暴露三个只读工具，且路径经 realpath 校验限制在绑定工作区。
- **不干扰主任务**：`ctx.llm.stream` 不带 `sessionId` 调用，绕过检查点策略与标题生成等会话级监听器；讨论的模型路由是独立的。
- **边界干净**：快照在最后一个 `turn/end` 处切开，未完成轮次与半截工具调用不进入讨论。

## 安装

```bash
# 在本机 DSH 会话里（注意 registry：该 profile 里 agent-live 的 pin 在 npmmirror 上不存在）
plugin_manager install_bundle  target=link:/Users/snail/projects/side-chat  registry=https://registry.npmjs.org/
```

装好后**刷新页面**。宿主侧改动需要重启 `dsh web`（Node 缓存 ESM：模块世代是进程启动时加载的，`/side-chat/ping` 的 `revision` 字段用来自查）。

## 测试

```bash
npm test                 # 宿主 14 项 + 客户端 6 项（全离线）
node test/real-fs.mjs    # 真实文件系统 13 项：沙箱边界、越界符号链接、spill 临时路径
npm run test:live        # 真实模型调用：快照、seed、流式、用量、关闭
SIDE_CHAT_TOOL=1 npm run test:live   # 强制走只读 read 工具
```

`test:live` 需要运行中的 profile 与 `DSH_SESSION_ID`，会花一次真实调用，因此不进 `npm test`。

## 运维

- **令牌**：无。路由是回环地址上的普通 HTTP 路由，没有鉴权（这是刻意的：它只服务本机的 GUI）。
- **空闲回收**：实例空闲 30 分钟后自动销毁；插件停用时全部销毁。
- **落盘检查**：`ls ~/.dsh/sessions/*/ | grep discussion` 应为空。

---

## 工具边界与拒绝策略（当前行为）

讨论会话的模型只被声明三个只读工具 `read` / `glob` / `grep`，由本插件自己实现（`ctx.fs` + realpath 边界），工作区限定为会话绑定的那块。

| 情况 | 行为 |
|---|---|
| 调了未声明的工具（bash / write / edit …） | 拒绝，并告知"本次只读会话只有 read/glob/grep"，**再给一次机会**改用只读工具；连续两轮全被拒才结束本轮 |
| 路径在工作区之外 | 同样给一次机会，并回报可访问范围 |
| **重复一个已经失败的调用** | 立即结束本轮（重试不可能得到不同结果） |

提示词开头也写明"历史里出现的 bash/write/edit 在本会话不可用，不要重复调用已被拒绝的工具"——因为 seed 进来的主会话历史里有那些成功调用，模型会照抄。

### 为什么是白名单而不是黑名单

`ctx.tools` 的契约允许无 Agent 调用（`ToolExecutionInput.agent` 是可选的，`schemas()`/`get()` 省略 scope 即全局视图），所以**技术上**可以列出全局工具、把"写/改/执行"类按名字挡掉、其余交给 `ctx.tools.execute`。但那会把保证方式从"结构上不可能改"换成"我按名字维护了一份清单"：

- `restrict()` / `guard()` 的语义是 **agent 作用域**的（`guard` 文档：普通上下文注册的**全局生效**）；没有 agent 就没有正确的作用域去收窄工具，也无法安全地遮蔽写工具；
- 工作区绑定、沙箱策略、审批管线同样是 agent 作用域，无 agent 调用会落到全局/默认上下文；
- 任何**新出现**的工具（插件、MCP、`run_code`、终端控制）默认就在清单之外。

因此维持"默认拒绝"。要真正放开采到的能力（`web_fetch` 等）按逐个加入白名单来做；要"全部可用"则必须让讨论会话拥有一个真 Agent（`agentCtx.tools.restrict({allow:[…]})` 给的是真工具 + 真策略）。

## 面板与主会话的对齐

- 输入区高 `var(--dsh-composer-height, 152px)`，内容**底部对齐**（`flex-end`），底部内边距用 `var(--dsh-composer-dock-inset, 8px)`；**不要**用 `translateY` 调位置——容器 `overflow:hidden` 会把底部那行裁掉（踩过一次）。
- 输入框下方是统计行（`.sc-statsline`，固定 22px，与主会话那行 pills 等高：`line-height 20px + 上下 1px`），**无数据时也渲染**，显示 `0 轮 0 步 · 0 tok · 0 tok/s · 缓存命中 0%`。
- 模型名右侧显示继承来的推理强度（`route.reasoningEffort`）。

## 两条踩坑记录（改客户端必读）

1. **改 `client.js` 之后必须重新发布**（Plugin Manager 里 disable→enable）再刷新。客户端模块 URL 带内容修订号，改文件不发布会让浏览器 404，表现为"入口/面板突然消失、控制台没有插件报错"。
2. **不要在入口注册上做"简化"**。`ctx.slots.register` 的选项保持 `{ name, id, order, locale }`；删除组件定义而留下引用时，inject 回调抛的 `ReferenceError` 会被槽位机制**吞掉**——面板照常注册、入口静默消失、没有任何报错。客户端测试现在会扫描文件，发现 `h()` 引用未定义组件或丢失样式表就失败。
