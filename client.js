/**
 * Client half of the temporary-discussion (临时会话) plugin.
 *
 * A self-contained panel: it renders its own transcript from the discussion
 * API's event stream, because the harness's own Conversation cannot be used for
 * a session created outside the agent lifecycle —
 *
 *  - the shipped composer needs an Agent (its submit goes through the Session
 *    Controller's prompt path into `ctx.agents`), and
 *  - the shipped Conversation's resource value only appears after the client
 *    controller can `open()` the session, which never completes for an
 *    out-of-band session, so `resource.value` stays undefined and nothing
 *    renders.
 *
 * The host half carries the substance: a real in-memory Session (nothing
 * persisted), the main session's completed prefix as a seed, requests composed from the fixed
 * message snapshot, summary and recent turns, and read-only tools.
 *
 * Styles are copied from the harness's own modules (InputBar, MessageItem,
 * StatsPills, ReasoningRow) so this panel matches the main session visually.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-side-chat',
  factory(require) {
    const React = require('react')
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const NS = 'sideChat'
    const TAB_ID = '@local/dsh-side-chat'
    const TAB_KIND = 'side-chat'
    const ROUTE = '/side-chat'

    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

    /** Square button metrics; CSS explicitly overrides the theme's corner shape. */
    const ROUND_BUTTON = {
      width: 34,
      height: 34,
      minWidth: 34,
      minHeight: 34,
      maxWidth: 34,
      maxHeight: 34,
      padding: 0,
      border: 0,
      borderRadius: '50%',
      aspectRatio: '1 / 1',
      flex: '0 0 auto',
      lineHeight: 0,
    }

    let sidebar = null
    /** The main composer of each session, for "放入主会话草稿". */
    const draftTargets = new Map()
    const composing = new Set()
    let compositionWaiters = []

    /* --------------------------------------------------------------- copy */

    const zh = {
      title: '临时会话',
      entry: '临时会话',
      entryOpen: '打开临时会话',
      entryClose: '关闭临时会话',
      badge: '只读会话 · 关闭后清空',
      parent: '主会话：{label}',
      snapshot: '快照 {time}',
      inherited: '继承 {turns} 轮 · 约 {tokens} tokens',
      inheritedEmpty: '主会话还没有已完成的内容',
      truncated: '已按上下文预算裁剪',
      omitted: '省略 {count} 条消息',
      tools: '可用工具：{tools}',
      workspace: '工作区：{path}',
      starting: '正在准备临时会话…',
      reopen: '重新打开讨论',
      retryOpen: '重试打开',
      ended: '临时讨论已结束',
      endedHint: '页面刷新或讨论关闭后，历史不会保留。可以重新打开讨论。',
      latest: '回到最新',
      process: '查阅过程',
      recoverQuestion: '重新编辑问题',
      emptySimple: '这是一个临时会话，关闭后会清除所有信息。',
      closing: '关闭中…',
      placeholder: '提出讨论问题，Enter 发送，Shift+Enter 换行',
      send: '发送',
      stop: '停止回答',
      stopping: '正在停止…',
      model: '模型',
      modelInherit: '继承自主会话',
      modelTitle: '模型：{provider} · {model} · 推理强度 {effort}',
      compact: '压缩上下文',
      compactDone: '已压缩讨论上下文。',
      compactFailed: '压缩失败：{message}',
      close: '关闭',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制失败，请重试。',
      answerActions: '回答操作',
      copyAnswer: '复制这条回答的 Markdown 正文',
      importAnswer: '导入到主会话',
      importAnswerHint: '将这条回答加入主会话草稿，不会自动发送',
      importedAnswer: '已加入草稿',
      footnotes: '脚注',
      codeTitle: '代码',
      codeWrap: '自动换行',
      codeUnwrap: '取消自动换行',
      toDraft: '放入主会话草稿',
      toDraftDone: '已放入主会话输入框。',
      toDraftMissing: '没有找到主会话的输入框，无法放入草稿。',
      reasoning: '思考过程',
      reasoningRunning: '思考中',
      toolRunning: '执行中',
      toolDone: '完成',
      toolFailed: '失败',
      stopped: '已停止',
      error: '请求失败：{message}',
      unanswered: '（本轮没有产生回答）',
      usage: '用量',
      usageInput: '输入',
      usageOutput: '输出',
      usageCacheRead: '缓存命中',
      usageCacheWrite: '缓存写入',
      usageCacheHit: '缓存命中',
      usageCacheHitRate: '缓存命中率',
      usageTitle: 'Token 用量',
      usageUncachedInput: '未缓存输入',
      usageCacheReadLabel: '缓存读取',
      usageTotalLine: '{value} tok',
      usageTtfb: '首字',
      usageTotal: '总耗时',
      usageTools: '工具调用',
      usageNoCache: '未上报缓存',
      closeTitle: '关闭临时会话？',
      closeBody: '本次会话历史不会保留，关闭后无法恢复。',
      closeBusy: '当前回答也会停止，主任务不受影响。',
      keepDiscussing: '继续讨论',
      closeAndClear: '关闭并清空',
    }

    const en = {
      title: 'Temporary session',
      entry: 'Temporary session',
      entryOpen: 'Open a temporary session',
      entryClose: 'Close the temporary session',
      badge: 'Read-only · cleared when closed',
      parent: 'Session: {label}',
      snapshot: 'Snapshot {time}',
      inherited: '{turns} turns inherited · about {tokens} tokens',
      inheritedEmpty: 'The session has no completed content yet',
      truncated: 'trimmed to the context budget',
      omitted: '{count} messages omitted',
      tools: 'Tools: {tools}',
      workspace: 'Workspace: {path}',
      starting: 'Preparing the temporary session…',
      reopen: 'Open a new discussion',
      retryOpen: 'Try opening again',
      ended: 'The temporary discussion has ended',
      endedHint: 'History is not kept after a page refresh or closing. You can open a new discussion.',
      latest: 'Back to latest',
      process: 'Exploration notes',
      recoverQuestion: 'Edit the question again',
      emptySimple: 'This is a temporary session. Closing it clears everything.',
      placeholder: 'Ask a question. Enter sends, Shift+Enter breaks the line',
      send: 'Send',
      stop: 'Stop answering',
      stopping: 'Stopping…',
      model: 'Model',
      modelInherit: 'inherited from the session',
      modelTitle: 'Model: {provider} · {model} · reasoning {effort}',
      compact: 'Compact context',
      compactDone: 'The discussion context was compacted.',
      compactFailed: 'Compaction failed: {message}',
      close: 'Close',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Copy failed. Please try again.',
      answerActions: 'Answer actions',
      copyAnswer: 'Copy this answer as Markdown',
      importAnswer: 'Add to main chat',
      importAnswerHint: 'Add this answer to the main chat draft without sending',
      importedAnswer: 'Added to draft',
      footnotes: 'Footnotes',
      codeTitle: 'Code',
      codeWrap: 'Wrap lines',
      codeUnwrap: 'Unwrap lines',
      toDraft: 'Add to the session draft',
      toDraftDone: 'Added to the main input box.',
      toDraftMissing: 'No main input box was found to add this to.',
      reasoning: 'Reasoning',
      reasoningRunning: 'Thinking',
      toolRunning: 'running',
      toolDone: 'done',
      toolFailed: 'failed',
      stopped: 'stopped',
      error: 'Request failed: {message}',
      unanswered: '(this turn produced no answer)',
      usage: 'Usage',
      usageInput: 'Input',
      usageOutput: 'Output',
      usageCacheRead: 'Cache read',
      usageCacheWrite: 'Cache write',
      usageCacheHit: 'Cache hit',
      usageTitle: 'Token usage',
      usageUncachedInput: 'Uncached input',
      usageCacheReadLabel: 'Cache read',
      usageTotalLine: '{value} tok',
      usageTtfb: 'First token',
      usageTotal: 'Total',
      usageTools: 'Tool calls',
      usageNoCache: 'cache not reported',
      closeTitle: 'Close the temporary session?',
      closeBody: 'This session history is not kept and cannot be restored.',
      closeBusy: 'The current answer stops too; the main task is unaffected.',
      keepDiscussing: 'Keep discussing',
      closeAndClear: 'Close and clear',
    }

    /* -------------------------------------------------------------- store */

    function createStore() {
      let state = {
        status: 'closed', // closed | creating | idle | generating | stopping | error
        parentSessionId: null,
        discussion: null,
        openError: null,
        notice: null,
        messages: [],
        live: null,
        models: null,
        pendingQuestion: null,
        tag: undefined,
        requestId: null,
        closeRequested: null,
      }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const store = createStore()

    function useStoreState() {
      const [state, setState] = useState(store.get())
      useEffect(() => store.subscribe(() => setState(store.get())), [])
      return state
    }

    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => (values?.[key] === undefined ? '' : String(values[key])))
    }

    /** Translate with the registered dictionary, falling back to Chinese. */
    function makeT(rawT) {
      return (key, values) => {
        let value
        try {
          value = rawT ? rawT(key, values) : undefined
        } catch {
          value = undefined
        }
        if (value === undefined || value === null || value === '' || value === key) {
          const fallback = zh[key] ?? key
          value = values ? fill(fallback, values) : fallback
        }
        return value
      }
    }

    function copy(ctx, key) {
      try {
        return ctx.locale.bind(NS)(key)
      } catch {
        return zh[key] ?? key
      }
    }

    function formatTime(value) {
      if (!value) return '—'
      try {
        return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch {
        return String(value)
      }
    }

    /* ---------------------------------------------------------------- api */

    async function api(path, body) {
      const response = await fetch(`${ROUTE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(text || `HTTP ${response.status}`)
      }
    }

    function reportFailure(stage, error) {
      try {
        window.console?.error?.(`[side-chat] ${stage} failed:`, error)
      } catch {
        /* console is optional */
      }
    }

    /* ------------------------------------------------------------ helpers */

    function newId(prefix) {
      return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }

    function previewText(text, limit = 400) {
      const value = String(text ?? '')
      return value.length > limit ? `${value.slice(0, limit)}…` : value
    }

    function emptyAnswer() {
      return { id: newId('a'), role: 'assistant', text: '', process: [], reasoning: '', tools: [], status: 'streaming', stats: null, notice: null, error: null }
    }

    /* -------------------------------------------------- markdown rendering */

    /** Use the main chat's incremental Markdown renderer and native styles. */
    function MarkdownBody({ t, text, streaming }) {
      const copyLabel = t('copy')
      const copiedLabel = t('copied')
      const footnotes = t('footnotes')
      const codeLabel = t('codeTitle')
      const wrapLabel = t('codeWrap')
      const unwrapLabel = t('codeUnwrap')
      // Stable labels preserve MarkdownText's streaming block cache.
      const labels = useMemo(() => ({
        code: { copyLabel, copiedLabel, toolbarLabels: { codeLabel, wrapLabel, unwrapLabel } },
        footnotes,
      }), [copyLabel, copiedLabel, codeLabel, wrapLabel, unwrapLabel, footnotes])
      return h('div', { className: 'sc-md' }, h(MarkdownText, { text, streaming, labels }))
    }

    /* ------------------------------------------------------------- drafts */

    function flushComposition() {
      const waiters = compositionWaiters
      compositionWaiters = []
      for (const resolve of waiters) resolve()
    }

    function whenNotComposing(timeoutMs = 4000) {
      if (composing.size === 0) return Promise.resolve()
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs)
        compositionWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
    }

    /** Append text to the main session's draft through the editor's own API. */
    async function appendToDraft(parentSessionId, text) {
      const target = draftTargets.get(parentSessionId)
      if (!target) return false
      await whenNotComposing()
      const latest = target.getDraft() ?? ''
      const separator = latest.trim().length === 0 ? '' : '\n\n---\n\n'
      target.inputActions.setDraft(`${latest}${separator}${text}`)
      return true
    }

    /* ------------------------------------------------------------ lifecycle */

    let openCounter = 0
    let activeRequest = null

    function requestClose(reopen = null) {
      const state = store.get()
      if (state.status === 'closed') return
      store.set({ closeRequested: { discussionId: state.discussion?.discussionId, tag: state.tag, parentSessionId: state.parentSessionId, reopen } })
    }

    async function confirmClose(closeTab) {
      const state = store.get()
      const pending = state.closeRequested
      if (!pending || pending.discussionId !== state.discussion?.discussionId || pending.tag !== state.tag || pending.parentSessionId !== state.parentSessionId) return
      if (!await closeDiscussion({ keepTab: Boolean(pending.reopen), closeTab })) return
      if (pending.reopen) await openDiscussion(pending.reopen.parentSessionId, pending.reopen.question)
    }

    async function openDiscussion(parentSessionId, question) {
      const existing = store.get()
      if (existing.parentSessionId === parentSessionId && existing.discussion && existing.status !== 'error') {
        if (question) sendQuestion(question)
        return existing.discussion
      }
      if (existing.discussion) {
        requestClose({ parentSessionId, question })
        return undefined
      }
      const tag = `panel-${++openCounter}-${Date.now()}`
      store.set({
        status: 'creating',
        parentSessionId,
        discussion: null,
        openError: null,
        notice: null,
        messages: [],
        live: null,
        pendingQuestion: question ?? null,
        tag,
        requestId: null,
        closeRequested: null,
      })
      try {
        const result = await api('/open', { parentSessionId, tag })
        if (!result.ok) throw new Error(result.message || '打开失败')
        if (store.get().tag !== tag) {
          api('/close', { discussionId: result.discussion.discussionId }).catch(() => {})
          return undefined
        }
        store.set({ status: 'idle', discussion: result.discussion, tag: undefined, lastStats: null })
        loadModels()
        const pending = store.get().pendingQuestion
        if (pending) {
          store.set({ pendingQuestion: null })
          sendQuestion(pending)
        }
        return result.discussion
      } catch (error) {
        if (store.get().tag !== tag) return undefined
        reportFailure('open', error)
        store.set({ status: 'error', openError: String(error?.message ?? error) })
        return undefined
      }
    }

    /** Read one turn's event stream into the transcript. */
    async function streamTurn(body, answer, signal) {
      const response = await fetch(`${ROUTE}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
        signal,
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let completed = false
      const apply = (frame) => {
        const state = store.get()
        if (frame.discussionId !== body.discussionId || frame.requestId !== body.requestId
          || state.discussion?.discussionId !== body.discussionId || state.requestId !== body.requestId) return
        const live = state.live ?? answer
        // Process notices expire on resumed progress; errors stay separately visible.
        if (frame.type === 'text' || frame.type === 'reasoning' || frame.type === 'done'
          || (frame.type === 'tool' && frame.status === 'running')) live.notice = null
        if (frame.type === 'step') {
          if (live.step && frame.step !== live.step) {
            if (live.text.trim()) live.process = [...(live.process ?? []), live.text]
            live.text = ''
          }
          live.step = frame.step
        } else if (frame.type === 'text') {
          live.text += frame.text ?? ''
        } else if (frame.type === 'reasoning') {
          live.reasoning += frame.text ?? ''
        } else if (frame.type === 'tool') {
          if (frame.status === 'running') {
            live.tools = [...live.tools, { name: frame.name, status: 'running', text: '' }]
          } else {
            const next = [...live.tools]
            for (let index = next.length - 1; index >= 0; index -= 1) {
              if (next[index].status === 'running' && next[index].name === frame.name) {
                next[index] = { ...next[index], status: frame.status, text: frame.text ?? '' }
                break
              }
            }
            live.tools = next
          }
        } else if (frame.type === 'notice') {
          live.notice = frame.message
        } else if (frame.type === 'error') {
          live.error = frame.message
        } else if (frame.type === 'done') {
          completed = true
          live.status = frame.status === 'stopped' ? 'stopped' : frame.status === 'error' ? 'error' : 'done'
          live.text = typeof frame.text === 'string' ? frame.text : live.text
          if (Array.isArray(frame.process)) live.process = frame.process
          live.stats = frame.stats ?? null
          live.streaming = false
          store.set({ live: { ...live }, lastStats: frame.type === 'done' ? frame.stats ?? null : store.get().lastStats })
          return
        }
        store.set({ live: { ...live } })
      }
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            const line = chunk.split('\n').find((row) => row.startsWith('data: '))
            if (!line) continue
            const payload = line.slice(6)
            if (payload === '[DONE]') {
              if (!completed) throw new Error('讨论连接提前结束，未收到完成状态。')
              return
            }
            let frame
            try {
              frame = JSON.parse(payload)
            } catch {
              continue
            }
            apply(frame)
          }
        }
        if (!completed && !signal?.aborted) throw new Error('讨论连接提前结束，未收到完成状态。')
      } finally {
        reader.releaseLock()
      }
    }

    async function sendQuestion(question) {
      const state = store.get()
      if (state.status === 'creating') {
        store.set({ pendingQuestion: question })
        return
      }
      if (state.status !== 'idle' || !state.discussion) return
      const requestId = newId('req')
      const discussionId = state.discussion.discussionId
      const request = { discussionId, requestId, controller: new AbortController() }
      activeRequest = request
      const ownsRequest = () => store.get().discussion?.discussionId === discussionId && store.get().requestId === requestId
      const answer = emptyAnswer()
      const messages = [...state.messages, { id: newId('q'), role: 'user', text: question }]
      store.set({ status: 'generating', requestId, notice: null, messages, live: answer })
      try {
        await streamTurn({ discussionId, requestId, text: question }, answer, request.controller.signal)
      } catch (error) {
        if (ownsRequest()) {
          reportFailure('send', error)
          store.set({ live: { ...(store.get().live ?? answer), status: 'error', error: String(error?.message ?? error) } })
        }
      } finally {
        if (activeRequest === request) activeRequest = null
        if (!ownsRequest()) return
        const settled = store.get().live ?? answer
        const finalMessages = [...store.get().messages]
        if (settled.text || settled.process?.length || settled.reasoning || settled.tools?.length > 0 || settled.error || settled.notice) {
          finalMessages.push({ ...settled, streaming: false, id: settled.id ?? answer.id })
        }
        store.set((current) => ({
          status: current.status === 'closed' ? 'closed' : 'idle',
          live: null,
          requestId: null,
          messages: finalMessages,
        }))
      }
    }

    async function stopAnswer() {
      const state = store.get()
      if (state.status !== 'generating' || !state.discussion) return
      store.set({ status: 'stopping' })
      try {
        await api('/cancel', { discussionId: state.discussion.discussionId, requestId: state.requestId })
      } catch (error) {
        reportFailure('cancel', error)
        if (store.get().discussion?.discussionId === state.discussion.discussionId && store.get().requestId === state.requestId) {
          activeRequest?.controller.abort()
        }
      }
    }

    async function loadModels() {
      if (store.get().models) return
      try {
        store.set({ models: await api('/models') })
      } catch {
        store.set({ models: { providers: [], models: {} } })
      }
    }

    async function closeDiscussion(options = {}) {
      const state = store.get()
      const closeGeneration = ++openCounter
      // Invalidate identity before aborting, so delayed callbacks cannot revive it.
      store.set({ status: 'closed', discussion: null, messages: [], live: null, lastStats: null, notice: null,
        tag: undefined, pendingQuestion: null, requestId: null, closeRequested: null })
      const request = activeRequest
      activeRequest = null
      request?.controller.abort()
      if (state.discussion) {
        const discussionId = state.discussion.discussionId
        try {
          await api('/close', { discussionId })
        } catch {
          /* the instance is gone either way */
        }
      }
      if (openCounter !== closeGeneration) return false
      if (options.keepTab !== true && options.closeTab) {
        try {
          // The tab's bound action retains its session even after navigation.
          options.closeTab()
        } catch (error) {
          reportFailure('closeTab', error)
        }
      }
      return true
    }

    /** The catalogue's display name for a route, when it is known. */
    function modelName(models, route) {
      const list = models?.models?.[route?.provider] ?? []
      return list.find((model) => model.id === route?.model)?.name ?? undefined
    }

    const CSS = `
.sc-root{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit);font-size:var(--dsh-content-font-size,14px);position:relative}
.sc-confirm{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:20px;background:var(--dsw-alias-bg-base)}
.sc-confirm-card{width:100%;max-width:360px;padding:20px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);line-height:22px}
.sc-confirm-card p{margin:12px 0}
.sc-grow{flex:1 1 auto;min-width:0}
.sc-head{display:flex;flex-direction:column;gap:3px;padding:10px 12px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none}
.sc-head-row{display:flex;align-items:center;gap:8px;min-width:0}
.sc-title{color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);font-weight:500;line-height:22px;white-space:nowrap}
.sc-badge{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary));font-size:var(--dsh-content-font-size-secondary,13px);line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-meta{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:var(--dsh-content-font-size-secondary,13px);line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sc-scroll{overflow-anchor:none;flex:1 1 auto;min-height:0;overflow-y:auto;scrollbar-gutter:stable;display:flex;flex-direction:column;gap:14px;padding:14px 12px 4px}
.sc-reading-controls{flex:none;display:flex;justify-content:center;padding:4px 12px}
.sc-latest{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:5px 12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.sc-latest:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sc-latest:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.sc-process{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
.sc-process>summary{cursor:pointer}
.sc-process .sc-md{margin-top:8px;color:var(--dsw-alias-label-secondary)}
.sc-turn{flex-shrink:0;display:flex;flex-direction:column;gap:8px;min-width:0}
.sc-question{align-self:flex-end;max-width:88%;box-sizing:border-box;background:var(--dsw-specific-bubble,var(--dsw-alias-bg-layer-1));border-radius:var(--dsw-radius-xl,12px);padding:10px 16px;white-space:pre-wrap;word-break:break-word;line-height:22px}
.sc-answer{display:flex;flex-direction:column;gap:8px;min-width:0}
.sc-answer-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sc-answer-toolbar{display:flex;align-items:center;gap:2px;margin-top:2px}
.sc-answer-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;min-width:28px;padding:6px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary,#798390);cursor:pointer;transition:background-color .12s,color .12s}
.sc-answer-action svg{width:16px;height:16px;flex:none}
.sc-answer-action:hover:not(:disabled){color:var(--dsw-alias-label-primary,#202b3a);background:var(--dsw-alias-interactive-bg-hover,#e9edf4)}
.sc-answer-action:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4669dc));outline-offset:2px}
.sc-answer-action:disabled{cursor:default;opacity:.65}
.sc-answer-action[data-feedback="true"]{color:var(--dsw-alias-label-primary,#202b3a)}
.sc-sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.sc-md{min-width:0}
.sc-reason{display:flex;flex-direction:column;gap:4px}
.sc-reason-row{display:flex;align-items:center;gap:6px;height:24px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:var(--dsh-content-font-size-secondary,13px);cursor:pointer;user-select:none}
.sc-reason-row:hover{color:var(--dsw-alias-label-secondary)}
.sc-reason-text{margin:0;padding:0 0 2px 2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;white-space:pre-wrap;word-break:break-word}
.sc-reason-text[data-streaming="true"]{-webkit-mask-image:linear-gradient(90deg,#000 calc(100% - 48px),transparent);mask-image:linear-gradient(90deg,#000 calc(100% - 48px),transparent)}
.sc-tools{display:flex;flex-direction:column;gap:4px}
.sc-tool{font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-secondary)}
.sc-tool-summary{display:flex;align-items:center;gap:6px;cursor:pointer;list-style:none}
.sc-tool-summary::-webkit-details-marker{display:none}
.sc-tool-details .sc-tool-summary:before{content:"›";display:inline-block;width:8px}
.sc-tool-details[open] .sc-tool-summary:before{transform:rotate(90deg)}
.sc-tool-name{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--dsw-alias-label-primary)}
.sc-tool-status{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.sc-tool[data-status="error"] .sc-tool-status{color:var(--dsw-alias-state-error-primary)}
.sc-tool-text{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:pre-wrap;word-break:break-word;margin:0;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}
.sc-statsline{box-sizing:border-box;min-width:0;max-width:100%;min-height:22px;display:flex;align-items:center;gap:12px;padding:1px 6px 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.sc-pills{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:2px}
.sc-pill{border:0;background:transparent;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font:inherit;font-size:12px;line-height:18px;border-radius:999px;padding:1px 8px;cursor:pointer}
.sc-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.sc-pill[data-static="true"]{cursor:default}
.sc-pill[data-static="true"]:hover{background:transparent}
.sc-usage{margin-top:4px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}
.sc-usage-row{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-secondary)}
.sc-usage-row b{font-weight:500;color:var(--dsw-alias-label-primary)}
.sc-notice{margin:0 12px 8px;padding:4px 8px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;white-space:pre-wrap}
.sc-notice[data-kind="error"]{color:var(--dsw-alias-state-error-primary)}
.sc-empty{flex:1 1 auto;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;text-align:center;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.sc-empty-title{margin-top:4px;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size,14px);font-weight:500;line-height:22px}
.sc-empty-desc{max-width:300px;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px}
.sc-facts{display:flex;flex-direction:column;gap:3px;max-width:340px;margin-top:6px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px}
.sc-composer{flex:none;margin-top:auto;display:flex;flex-direction:column;padding:0 16px 4px}
.sc-dock{display:flex;min-width:0;padding-top:4px}
.sc-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;width:100%;--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));box-shadow:var(--dsw-elevation-soft,none);position:relative;padding-top:8px}
.sc-input{box-sizing:border-box;width:calc(100% - 4px);margin-right:4px;height:auto;min-height:36px;resize:none;border:0;background:transparent;color:var(--dsw-alias-label-primary);caret-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));font-family:var(--dsw-font-family,inherit);font-size:var(--dsh-content-font-size,14px);line-height:calc(24px + var(--dsh-content-font-delta,0px));outline:none;overflow-y:auto;padding:4px 8px 0 14px}
.sc-input::placeholder{color:var(--dsw-alias-label-caption,var(--dsw-alias-label-secondary))}
.sc-row{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;min-width:0;padding:2px 8px 6px}
.sc-tools-row{display:flex;align-items:center;gap:12px;min-width:0}
.sc-trailing{display:flex;align-items:center;gap:12px;flex:none;margin-left:auto}
.sc-select{box-sizing:border-box;max-width:220px;height:28px;border:0;border-radius:var(--dsw-radius-sm,6px);background-color:transparent;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-position:right 4px center;background-repeat:no-repeat;background-size:12px 12px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;appearance:none;outline:none;padding:0 20px 0 8px}
.sc-select:hover{background-color:var(--dsw-alias-interactive-bg-hover)}
.sc-label{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:13px;line-height:20px}
.sc-primary{box-sizing:border-box;display:grid;place-items:center;flex:none;width:34px;height:34px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-button-info-fill,var(--dsw-alias-brand-primary));color:#fff;cursor:pointer;transition:background-color .1s;transform:translateY(-2px);padding:0}
.sc-primary:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,var(--dsw-alias-button-info-fill))}
.sc-primary:disabled{opacity:.4;cursor:default}
.sc-icon{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}
.sc-icon:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sc-icon[data-open="true"]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary))}
.sc-iconBtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer;flex:none}
.sc-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.sc-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis}
.sc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sc-btn:disabled{cursor:not-allowed;opacity:.4}
.sc-btn.primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));color:var(--dsw-alias-label-primary-foreground,#fff)}
.sc-btn.primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}
.sc-modal{position:absolute;inset:0;background:rgba(15,23,42,.36);display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
.sc-dialog{background:var(--dsw-alias-bg-overlay);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,12px);padding:16px;max-width:340px;display:flex;flex-direction:column;gap:8px;box-shadow:0 12px 32px rgba(0,0,0,.28)}
.sc-dialog h3{margin:0;font-size:var(--dsh-content-font-size,14px);line-height:22px}
.sc-dialog p{margin:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:20px;color:var(--dsw-alias-label-secondary)}
.sc-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:4px}
.sc-spin{animation:sc-spin 1s linear infinite}
@keyframes sc-spin{to{transform:rotate(360deg)}}
`
    /** The composer entry; it also publishes this session's draft actions. */
    function DiscussionEntry(props) {
      const { sessionId, inputActions } = props
      const t = makeT(props.t)
      const state = useStoreState()
      const draftRef = useRef('')
      const draft = props.useInput ? props.useInput((value) => value.draft) : ''
      draftRef.current = draft

      useEffect(() => {
        if (!sessionId || !inputActions) return undefined
        draftTargets.set(sessionId, { inputActions, getDraft: () => draftRef.current })
        return () => {
          if (draftTargets.get(sessionId)?.inputActions === inputActions) draftTargets.delete(sessionId)
        }
      }, [sessionId, inputActions])

      const active = state.parentSessionId === sessionId && state.status !== 'closed'
      const open = useCallback(() => {
        try {
          sidebar?.openTab?.(TAB_KIND)
        } catch (error) {
          reportFailure('openTab', error)
        }
        if (!active) openDiscussion(sessionId)
      }, [active, sessionId])

      return h(
        React.Fragment,
        null,
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'sc-icon',
            'data-open': active ? 'true' : 'false',
            title: active ? t('entryOpen') : t('entry'),
            'aria-label': t('entry'),
            onClick: open,
          },
          h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
            h('path', {
              d: 'M4 5.5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinejoin: 'round',
            }),
            h('path', {
              d: 'M18 9.5h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1v3l-3.5-3H12',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinejoin: 'round',
              opacity: 0.7,
            }),
          ),
        ),
      )
    }

    /** The one-line session stats that fill the composer's reserved height. */
    function UsageLine({ t, messages, lastStats, discussion }) {
      const compact = (value) => {
        const n = Number(value ?? 0)
        if (n >= 1_000_000_000) return `${Math.round(n / 1_000_000_000)}B`
        if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
        if (n >= 1_000) return `${Math.round(n / 1_000)}k`
        return String(Math.round(n))
      }
      const turns = messages.filter((message) => message.role === 'assistant').length
      let input = 0
      let output = 0
      let cacheRead = 0
      let cacheWrite = 0
      for (const message of messages) {
        const stats = message.stats
        if (!stats) continue
        input += Number(stats.inputTokens ?? 0)
        output += Number(stats.outputTokens ?? 0)
        cacheRead += Number(stats.cacheReadTokens ?? 0)
        cacheWrite += Number(stats.cacheWriteTokens ?? 0)
      }
      const total = input + output + cacheRead + cacheWrite
      const billed = input + cacheRead + cacheWrite
      const percent = billed > 0 ? Math.round((cacheRead / billed) * 100) : 0
      const tokPerSec = lastStats && Number(lastStats.totalMs) > 0 ? Math.round(output / (Number(lastStats.totalMs) / 1000)) : 0
      const steps = Number(lastStats?.steps ?? discussion?.steps ?? 0)
      const parts = [
        `${turns} 轮 ${steps} 步`,
        `${compact(total)} tok`,
        `${tokPerSec} tok/s`,
        `${t('usageCacheHit')} ${percent}%`,
      ]
      // Always render the row so it reserves its 22px even before any turn.
      return h('div', { className: 'sc-statsline' }, parts.join(' · ') || '\u00A0')
    }

    /** Collapsible reasoning, streaming-aware. */

    /** Collapsible reasoning, streaming-aware. */
    function ReasoningRow({ t, text, streaming }) {
      const [open, setOpen] = useState(false)
      const preview = text.length > 120 ? text.slice(-120) : text
      return h(
        'div',
        { className: 'sc-reason' },
        h(
          'div',
          { className: 'sc-reason-row', onClick: () => setOpen((value) => !value) },
          h(
            'svg',
            { width: 12, height: 12, viewBox: '0 0 12 12', fill: 'none', 'aria-hidden': true },
            h('path', {
              d: open ? 'M2.5 7.5L6 4l3.5 3.5' : 'M2.5 4.5L6 8l3.5-3.5',
              stroke: 'currentColor',
              strokeWidth: 1.4,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }),
          ),
          h('span', null, streaming ? t('reasoningRunning') : t('reasoning')),
        ),
        streaming && !open
          ? h('div', { className: 'sc-reason-text', 'data-streaming': 'true' }, preview)
          : open
            ? h('div', { className: 'sc-reason-text' }, text)
            : null,
      )
    }

    /** Token and timing pills; the summary pill opens the full breakdown. */

    function ToolRow({ t, tool }) {
      const label = tool.status === 'running' ? t('toolRunning') : tool.status === 'error' ? t('toolFailed') : t('toolDone')
      const summary = [
        h('span', { className: 'sc-tool-name', key: 'name' }, tool.name),
        h('span', { className: 'sc-tool-status', key: 'status' }, `· ${label}`),
      ]
      return tool.text
        ? h('details', { className: 'sc-tool sc-tool-details', 'data-status': tool.status },
            h('summary', { className: 'sc-tool-summary' }, summary),
            h('pre', { className: 'sc-tool-text' }, previewText(tool.text)))
        : h('div', { className: 'sc-tool', 'data-status': tool.status },
            h('div', { className: 'sc-tool-summary' }, summary))
    }

    function AnswerActionIcon({ kind }) {
      return h('svg', { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        kind === 'check'
          ? h('path', { d: 'M4 10l4 4 8-8' })
          : kind === 'copy'
            ? [h('rect', { key: 'front', x: 7, y: 7, width: 10, height: 10, rx: 2 }),
              h('path', { key: 'back', d: 'M12 4V3H3v9h1' })]
            : [h('path', { key: 'bubble', d: 'M8 4H3v13l4-3h10v-4' }),
              h('path', { key: 'arrow', d: 'M10 3h7v7M17 3l-8 8' })])
    }

    function AnswerActions({ t, body, parentSessionId, notify }) {
      const [feedback, setFeedback] = useState(null)
      const [pending, setPending] = useState(null)
      const inFlight = useRef(false)
      const feedbackTimer = useRef(null)
      useEffect(() => () => clearTimeout(feedbackTimer.current), [])
      const act = async (kind) => {
        if (inFlight.current) return
        inFlight.current = true
        setPending(kind)
        try {
          if (kind === 'copy') await navigator.clipboard.writeText(body)
          else if (!await appendToDraft(parentSessionId, body)) {
            notify(t('toDraftMissing'))
            return
          }
          clearTimeout(feedbackTimer.current)
          setFeedback(kind)
          feedbackTimer.current = setTimeout(() => setFeedback(null), 2000)
        } catch (error) {
          reportFailure(kind, error)
          notify(t(kind === 'copy' ? 'copyFailed' : 'toDraftMissing'))
        } finally {
          inFlight.current = false
          setPending(null)
        }
      }
      return h('div', { className: 'sc-answer-toolbar', role: 'group', 'aria-label': t('answerActions') },
        ['copy', 'draft'].map(kind => h('button', {
          key: kind, type: 'button', className: 'sc-answer-action', 'data-action': kind,
          'data-feedback': feedback === kind, disabled: pending !== null,
          title: t(feedback === kind ? kind === 'copy' ? 'copied' : 'importedAnswer' : kind === 'copy' ? 'copyAnswer' : 'importAnswerHint'),
          'aria-label': t(kind === 'copy' ? 'copy' : 'importAnswer'),
          'aria-busy': pending === kind,
          onClick: () => act(kind),
        }, h(AnswerActionIcon, { kind: feedback === kind ? 'check' : kind }))),
        h('span', { className: 'sc-sr-only', role: 'status', 'aria-live': 'polite' },
          feedback ? t(feedback === 'copy' ? 'copied' : 'importedAnswer') : ''))
    }

    /** One assistant answer: reasoning, tools, markdown body, usage, actions. */
    function AnswerBlock({ t, message, parentSessionId, notify, onRecover }) {
      const streaming = message.status === 'streaming'
      const body = message.text?.trim() ? message.text : ''
      return h(
        'div',
        { className: 'sc-answer' },
        message.reasoning ? h(ReasoningRow, { t, text: message.reasoning, streaming }) : null,
        message.tools?.length
          ? h('div', { className: 'sc-tools' }, message.tools.map((tool, index) => h(ToolRow, { t, tool, key: `${tool.name}-${index}` })))
          : null,
        message.process?.length ? h('details', { className: 'sc-process' },
          h('summary', null, t('process')),
          message.process.map((text, index) => h(MarkdownBody, { key: index, t, text, streaming: false }))) : null,
        body
          ? h(MarkdownBody, { t, text: body, streaming })
          : streaming && !message.reasoning
            ? h('div', { className: 'sc-tool-status' }, t('reasoningRunning'))
            : !streaming && message.error
              ? h('div', { className: 'sc-tool-status' }, t('unanswered'))
              : null,
        message.notice ? h('div', { className: 'sc-notice' }, message.notice) : null,
        message.status === 'stopped' ? h('div', { className: 'sc-tool-status' }, t('stopped')) : null,
        !streaming && message.error
          ? h('div', { className: 'sc-notice', 'data-kind': 'error' }, fill(t('error'), { message: message.error }))
          : null,
        !streaming && message.error && onRecover ? h('button', { type: 'button', className: 'sc-btn', onClick: onRecover }, t('recoverQuestion')) : null,
        !streaming && body ? h(AnswerActions, { t, body, parentSessionId, notify }) : null,
      )
    }

    function PreparingState({ t }) {
      const [showSpinner, setShowSpinner] = useState(false)
      useEffect(() => {
        const timer = setTimeout(() => setShowSpinner(true), 200)
        return () => clearTimeout(timer)
      }, [])
      return h('div', { className: 'sc-empty' },
        showSpinner ? h('svg', { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', className: 'sc-spin', 'aria-hidden': true },
          h('path', { d: 'M12 3a9 9 0 1 0 9 9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })) : null,
        h('div', { className: 'sc-empty-title' }, t('starting')))
    }

    /** The panel: header facts, transcript, composer, close confirmation. */
    function DiscussionPanel(props) {
      const t = makeT(props.t)
      const sharedState = useStoreState()
      const [draft, setDraft] = useState('')
      const [notice, setNotice] = useState(null)
      const scrollRef = useRef(null)
      const inputRef = useRef(null)
      const focusedDiscussion = useRef(null)
      const followBottom = useRef(true)
      const previousTurn = useRef(null)
      const [showLatest, setShowLatest] = useState(false)
      const tabInfo = props.hooks?.tabInfo?.()
      const tabSignal = tabInfo?.tab.signal
      const ownerSessionId = props.sessionId ?? sharedState.parentSessionId
      const ownsDiscussion = ownerSessionId === sharedState.parentSessionId
      // A previously opened tab must never expose another session's transcript.
      const state = ownsDiscussion ? sharedState : { ...sharedState, status: 'closed', discussion: null,
        messages: [], live: null, lastStats: null, openError: null, notice: null,
        closeRequested: sharedState.closeRequested?.reopen?.parentSessionId === ownerSessionId ? sharedState.closeRequested : null }

      const busy = state.status === 'generating' || state.status === 'stopping'
      const discussion = state.discussion
      const messages = state.messages
      const live = state.live

      useEffect(() => {
        setDraft('')
        setNotice(null)
        setShowLatest(false)
        followBottom.current = true
        previousTurn.current = null
      }, [ownerSessionId, discussion?.discussionId])

      useEffect(() => {
        const element = scrollRef.current
        // A new question follows its own answer; streaming respects reader intent.
        if (state.requestId && previousTurn.current !== state.requestId) {
          previousTurn.current = state.requestId
          followBottom.current = true
          setShowLatest(false)
        }
        if (element && followBottom.current) element.scrollTop = element.scrollHeight
      }, [discussion?.discussionId, state.requestId, messages.length, live])

      const resizeInput = useCallback(() => {
        const input = inputRef.current
        if (!input) return
        input.style.height = 'auto'
        input.style.height = `${Math.min(180, Math.max(36, input.scrollHeight))}px`
      }, [])
      useEffect(resizeInput, [draft, discussion?.discussionId, resizeInput])
      useEffect(() => {
        const input = inputRef.current
        if (!input || typeof ResizeObserver === 'undefined') return
        let width = input.getBoundingClientRect().width
        const observer = new ResizeObserver(() => {
          const nextWidth = input.getBoundingClientRect().width
          if (nextWidth !== width) { width = nextWidth; resizeInput() }
        })
        observer.observe(input)
        return () => observer.disconnect()
      }, [discussion?.discussionId, resizeInput])
      useEffect(() => {
        const id = discussion?.discussionId
        if (id && id !== focusedDiscussion.current && !state.closeRequested) {
          inputRef.current?.focus()
          focusedDiscussion.current = id
        }
      }, [discussion?.discussionId, state.closeRequested])

      useEffect(() => {
        loadModels()
      }, [])

      // Hiding/unmounting a body is not an explicit close. The tab lifetime
      // signal also covers removal paths that bypass the chrome handler.
      useEffect(() => {
        if (!tabSignal) return undefined
        const dispose = () => {
          if (store.get().status !== 'closed' && store.get().parentSessionId === ownerSessionId) closeDiscussion({ keepTab: true })
        }
        if (tabSignal.aborted) dispose()
        else tabSignal.addEventListener('abort', dispose, { once: true })
        return () => tabSignal.removeEventListener('abort', dispose)
      }, [tabSignal, ownerSessionId])

      const notify = useCallback((message) => {
        setNotice(message)
        setTimeout(() => setNotice(null), 4000)
      }, [])

      const submit = () => {
        const text = draft.trim()
        if (!text || busy || !discussion || state.status !== 'idle') return
        setDraft('')
        sendQuestion(text)
        inputRef.current?.focus()
      }
      const recover = question => { setDraft(question); inputRef.current?.focus() }
      const backToLatest = () => {
        followBottom.current = true
        setShowLatest(false)
        const element = scrollRef.current
        if (element) element.scrollTop = element.scrollHeight
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          if (event.nativeEvent?.isComposing) return
          event.preventDefault()
          submit()
        }
      }

      const route = discussion?.route

      return h(
        'div',
        { className: 'sc-root' },
        h('style', null, CSS),
        state.closeRequested ? h('div', { className: 'sc-confirm' },
          h('div', { className: 'sc-confirm-card', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'sc-close-title' },
            h('strong', { id: 'sc-close-title' }, t('closeTitle')),
            h('p', null, t('closeBody')),
            busy ? h('p', null, t('closeBusy')) : null,
            h('div', { className: 'sc-answer-actions' },
              h('button', { type: 'button', className: 'sc-btn', autoFocus: true, onClick: () => store.set({ closeRequested: null }) }, t('keepDiscussing')),
              h('button', { type: 'button', className: 'sc-btn', onClick: () => confirmClose(tabInfo?.tab.actions.close) }, t('closeAndClear')),
            ),
          ),
        ) : null,
        state.openError && state.status !== 'error' ? h('div', { className: 'sc-notice', 'data-kind': 'error' }, state.openError) : null,
        !discussion && state.status === 'creating' ? h(PreparingState, { t }) : null,
        !discussion && state.status === 'closed' ? h('div', { className: 'sc-empty' },
          h('div', { className: 'sc-empty-title' }, t('ended')),
          h('div', { className: 'sc-empty-desc' }, t('endedHint')),
          h('button', { type: 'button', className: 'sc-btn', onClick: () => openDiscussion(ownerSessionId) }, t('reopen'))) : null,
        !discussion && state.status === 'error'
          ? h(
              'div',
              { className: 'sc-empty' },
              h(
                'svg',
                { width: 40, height: 40, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                h('circle', { cx: 12, cy: 12, r: 9, stroke: 'currentColor', strokeWidth: 1.4 }),
                h('path', { d: 'M12 7.5v5.5M12 16.5v.5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
              ),
              h('div', { className: 'sc-empty-title' }, fill(t('error'), { message: state.openError ?? '' })),
              h('button', { type: 'button', className: 'sc-btn', onClick: () => openDiscussion(ownerSessionId) }, t('retryOpen')),
            )
          : null,
        discussion
          ? h(
              'div',
              { className: 'sc-scroll', ref: scrollRef,
                onScroll: (event) => {
                  const element = event.currentTarget
                  followBottom.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24
                  setShowLatest(!followBottom.current)
                },
                onWheel: (event) => { if (event.deltaY < 0) { followBottom.current = false; setShowLatest(true) } },
              },
              messages.length === 0 && !live
                ? h(
                    'div',
                    { className: 'sc-empty' },
                    h(
                      'svg',
                      { width: 44, height: 44, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
                      h('path', {
                        d: 'M4 5.5h11a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H9l-3.5 3v-3H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
                        stroke: 'currentColor',
                        strokeWidth: 1.4,
                        strokeLinejoin: 'round',
                      }),
                      h('path', {
                        d: 'M18 9.5h2a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-1v3l-3.5-3H12',
                        stroke: 'currentColor',
                        strokeWidth: 1.4,
                        strokeLinejoin: 'round',
                        opacity: 0.6,
                      }),
                    ),
                    h('div', { className: 'sc-empty-title' }, t('emptySimple')),
                  )
                : null,
              messages.map((message, index) =>
                message.role === 'user'
                  ? h('div', { className: 'sc-turn', key: message.id ?? index }, h('div', { className: 'sc-question' }, message.text))
                  : h('div', { className: 'sc-turn', key: message.id ?? index }, h(AnswerBlock, { t, message, parentSessionId: state.parentSessionId, notify,
                      onRecover: index > 0 && messages[index - 1]?.role === 'user' ? () => recover(messages[index - 1].text) : undefined })),
              ),
              live ? h('div', { className: 'sc-turn' }, h(AnswerBlock, { t, message: { ...live, status: 'streaming' }, parentSessionId: state.parentSessionId, notify })) : null,
            )
          : null,
        discussion && showLatest ? h('div', { className: 'sc-reading-controls' },
          h('button', { type: 'button', className: 'sc-latest', onClick: backToLatest }, `↓ ${t('latest')}`)) : null,
        notice ? h('div', { className: 'sc-notice' }, notice) : null,
        state.notice ? h('div', { className: 'sc-notice', 'data-kind': 'error' }, state.notice) : null,
        discussion
          ? h(
              'div',
              { className: 'sc-composer' },
              h(
                'div',
                { className: 'sc-card' },
                h('textarea', {
                  className: 'sc-input',
                  ref: inputRef,
                  value: draft,
                  placeholder: t('placeholder'),
                  rows: 1,
                  onChange: (event) => setDraft(event.target.value),
                  onKeyDown,
                  onFocus: () => loadModels(),
                  onCompositionStart: () => composing.add('*'),
                  onCompositionEnd: () => {
                    composing.delete('*')
                    flushComposition()
                  },
                }),
                h(
                  'div',
                  { className: 'sc-row' },
                  h(
                    'div',
                    { className: 'sc-tools-row' },
                    h(
                      'span',
                      {
                        className: 'sc-label',
                        title: route
                          ? fill(t('modelTitle'), { provider: route.provider, model: route.model, effort: route.reasoningEffort ?? '—' })
                          : t('model'),
                      },
                      route
                        ? `${modelName(state.models, route) ?? route.model}${route.reasoningEffort ? ` · ${route.reasoningEffort}` : ''}`
                        : t('modelInherit'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'sc-trailing' },
                    busy ? h('span', { className: 'sc-label' }, state.status === 'stopping' ? t('stopping') : '') : null,
                    busy
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'sc-primary',
                            style: ROUND_BUTTON,
                            onClick: stopAnswer,
                            disabled: state.status === 'stopping',
                            title: t('stop'),
                            'aria-label': t('stop'),
                          },
                          h(
                            'svg',
                            { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
                            h('rect', { x: 3, y: 3, width: 10, height: 10, rx: 3, fill: 'currentColor' }),
                          ),
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'sc-primary',
                            style: ROUND_BUTTON,
                            onClick: submit,
                            disabled: draft.trim().length === 0,
                            title: t('send'),
                            'aria-label': t('send'),
                          },
                          h(
                            'svg',
                            { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': true },
                            h('path', {
                              d: 'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',
                              fill: 'currentColor',
                            }),
                          ),
                        ),
                  ),
                ),
              ),
              h('div', { className: 'sc-dock' }, h(UsageLine, { t, messages, lastStats: state.lastStats, discussion })),
            )
          : null,
      )
    }

    /* --------------------------------------------------------------- glue */

    function apply(ctx) {
      sidebar = ctx.sidebarRight

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'side-chat:copy')

      ctx.effect(() => {
        const start = () => composing.add('*')
        const end = () => {
          composing.delete('*')
          flushComposition()
        }
        document.addEventListener('compositionstart', start, true)
        document.addEventListener('compositionend', end, true)
        return () => {
          document.removeEventListener('compositionstart', start, true)
          document.removeEventListener('compositionend', end, true)
          composing.clear()
          flushComposition()
        }
      }, 'side-chat:ime')

      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.left', () =>
            ctx.slots.register({ name: 'conversation.input.left', id: TAB_ID, order: 50, locale: NS }, DiscussionEntry),
          ),
        'side-chat:entry',
      )

      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            canOpen: () => false,
            title: () => copy(ctx, 'title'),
            // A tab type that owns no address is offered through the sidebar's
            // guide card; this is its documented entry point.
            guide: [
              {
                id: TAB_KIND,
                order: 40,
                title: () => copy(ctx, 'title'),
                description: () => copy(ctx, 'entryOpen'),
              },
            ],
          }),
        'side-chat:tab',
      )

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, DiscussionPanel),
          ),
        'side-chat:panel',
      )

      // A close from the tab chrome must ask first: the sidebar documents that a
      // FAILING close handler preserves the tab, so the unconfirmed path throws
      // and the confirm renders in the still-mounted panel.
      ctx.effect(() => ctx.sidebarRight.registerCloseHandler(TAB_KIND, (sessionId) => {
        const state = store.get()
        if (state.status === 'closed' || state.parentSessionId !== sessionId) return
        requestClose()
        throw new Error(copy(ctx, 'closeTitle'))
      }), 'side-chat:close-confirm')
      ctx.effect(() => () => closeDiscussion({ keepTab: true }), 'side-chat:teardown')
    }

    return { inject, apply }
  },
})
