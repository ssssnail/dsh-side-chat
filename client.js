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
 * persisted), the main session's completed prefix as a seed, requests derived by
 * `session.deriveMessages()`, and read-only tools.
 *
 * Styles are copied from the harness's own modules (InputBar, MessageItem,
 * StatsPills, ReasoningRow) so this panel matches the main session visually.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-side-chat',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback } = React

    const NS = 'sideChat'
    const TAB_ID = '@local/dsh-side-chat'
    const TAB_KIND = 'side-chat'
    const ROUTE = '/side-chat'

    const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs']

    /** The send/stop button is a circle by construction, not by stylesheet. */
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
      emptySimple: '这是一个临时会话，关闭后会清除所有信息。',
      closing: '关闭中…',
      placeholder: '提出讨论问题，Enter 发送，Shift+Enter 换行',
      send: '发送',
      stop: '停止回答',
      stopping: '正在停止…',
      model: '模型',
      modelInherit: '继承自主会话',
      modelTitle: '模型：{provider} · {model}',
      compact: '压缩上下文',
      compactDone: '已压缩讨论上下文。',
      compactFailed: '压缩失败：{message}',
      close: '关闭',
      copy: '复制',
      copied: '已复制',
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
      usageCacheHit: '缓存命中率',
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
      emptySimple: 'This is a temporary session. Closing it clears everything.',
      placeholder: 'Ask a question. Enter sends, Shift+Enter breaks the line',
      send: 'Send',
      stop: 'Stop answering',
      stopping: 'Stopping…',
      model: 'Model',
      modelInherit: 'inherited from the session',
      modelTitle: 'Model: {provider} · {model}',
      compact: 'Compact context',
      compactDone: 'The discussion context was compacted.',
      compactFailed: 'Compaction failed: {message}',
      close: 'Close',
      copy: 'Copy',
      copied: 'Copied',
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
      return { id: newId('a'), role: 'assistant', text: '', reasoning: '', tools: [], status: 'streaming', stats: null, notice: null, error: null }
    }

    /* -------------------------------------------------- markdown rendering */

    const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

    function escapeHtml(text) {
      return String(text ?? '').replace(/[&<>"']/g, (character) => ESCAPES[character])
    }

    /** Inline spans: code, bold, italic, strikethrough, links. */
    function renderInline(source) {
      let html = escapeHtml(source)
      const codeSpans = []
      html = html.replace(/`([^`\n]+)`/g, (_, code) => {
        codeSpans.push(code)
        return `\u0000${codeSpans.length - 1}\u0000`
      })
      html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, href) => {
        return `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`
      })
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      html = html.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
      html = html.replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      html = html.replace(/\u0000(\d+)\u0000/g, (_, index) => `<code>${codeSpans[Number(index)]}</code>`)
      return html
    }

    /**
     * A small markdown subset: fenced code, headings, lists, quotes, rules and
     * paragraphs. Deliberately not a full parser — the panel only has to render
     * model answers legibly.
     */
    function renderMarkdown(source) {
      const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
      const out = []
      let index = 0
      while (index < lines.length) {
        const line = lines[index]
        const fence = /^\s*```(\S*)\s*$/.exec(line)
        if (fence) {
          const code = []
          index += 1
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
            code.push(lines[index])
            index += 1
          }
          index += 1
          const language = fence[1] ? ` data-language="${escapeHtml(fence[1])}"` : ''
          out.push(`<pre class="sc-code"${language}><code>${escapeHtml(code.join('\n'))}</code></pre>`)
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = Math.min(heading[1].length + 2, 6)
          out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
          index += 1
          continue
        }
        if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line)) {
          out.push('<hr/>')
          index += 1
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const quote = []
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quote.push(lines[index].replace(/^\s*>\s?/, ''))
            index += 1
          }
          out.push(`<blockquote>${renderMarkdown(quote.join('\n'))}</blockquote>`)
          continue
        }
        const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
        if (bullet || numbered) {
          const ordered = Boolean(numbered)
          const items = []
          while (index < lines.length) {
            const match = ordered ? /^\s*\d+[.)]\s+(.*)$/.exec(lines[index]) : /^\s*[-*+]\s+(.*)$/.exec(lines[index])
            if (!match) break
            items.push(`<li>${renderInline(match[1])}</li>`)
            index += 1
          }
          out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`)
          continue
        }
        if (line.trim() === '') {
          index += 1
          continue
        }
        const paragraph = []
        while (
          index < lines.length &&
          lines[index].trim() !== '' &&
          !/^\s*```/.test(lines[index]) &&
          !/^#{1,6}\s+/.test(lines[index]) &&
          !/^\s*[-*+]\s+/.test(lines[index]) &&
          !/^\s*\d+[.)]\s+/.test(lines[index]) &&
          !/^\s*>\s?/.test(lines[index])
        ) {
          paragraph.push(lines[index])
          index += 1
        }
        out.push(`<p>${renderInline(paragraph.join('\n')).replace(/\n/g, '<br/>')}</p>`)
      }
      return out.join('')
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

    async function openDiscussion(parentSessionId, question) {
      const existing = store.get()
      if (existing.parentSessionId === parentSessionId && existing.discussion && existing.status !== 'error') {
        if (question) sendQuestion(question)
        return existing.discussion
      }
      if (existing.discussion) await closeDiscussion({ keepTab: true })
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
      })
      try {
        const result = await api('/open', { parentSessionId, tag })
        if (!result.ok) throw new Error(result.message || '打开失败')
        if (store.get().tag !== tag) {
          api('/close', { discussionId: result.discussion.discussionId }).catch(() => {})
          return undefined
        }
        store.set({ status: 'idle', discussion: result.discussion, tag: undefined })
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
    async function streamTurn(body, answer) {
      const response = await fetch(`${ROUTE}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      const apply = (frame) => {
        const state = store.get()
        const live = state.live ?? answer
        if (frame.type === 'text') {
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
          live.status = frame.status === 'stopped' ? 'stopped' : frame.status === 'error' ? 'error' : 'done'
          live.text = live.text || frame.text || ''
          live.stats = frame.stats ?? null
          live.streaming = false
          store.set({ live: { ...live } })
          return
        }
        store.set({ live: { ...live } })
      }
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
            buffer = ''
            break
          }
          try {
            apply(JSON.parse(payload))
          } catch {
            /* a partial frame is not an event */
          }
        }
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
      const answer = emptyAnswer()
      const messages = [...state.messages, { id: newId('q'), role: 'user', text: question }]
      store.set({ status: 'generating', notice: null, messages, live: answer })
      try {
        await streamTurn({ discussionId: state.discussion.discussionId, requestId, text: question }, answer)
      } catch (error) {
        reportFailure('send', error)
        answer.status = 'error'
        answer.error = String(error?.message ?? error)
      } finally {
        const settled = store.get().live ?? answer
        const finalMessages = [...store.get().messages]
        if (settled.text || settled.reasoning || settled.tools?.length > 0 || settled.error || settled.notice) {
          finalMessages.push({ ...settled, streaming: false, id: settled.id ?? answer.id })
        }
        store.set((current) => ({
          status: current.status === 'closed' ? 'closed' : 'idle',
          live: null,
          messages: finalMessages,
        }))
      }
    }

    async function stopAnswer() {
      const state = store.get()
      if (state.status !== 'generating' || !state.discussion) return
      store.set({ status: 'stopping' })
      try {
        await api('/cancel', { discussionId: state.discussion.discussionId })
      } catch (error) {
        reportFailure('cancel', error)
        store.set({ status: 'idle' })
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
      if (state.discussion) {
        const discussionId = state.discussion.discussionId
        store.set({ status: 'closed', discussion: null, messages: [], live: null, notice: null })
        try {
          await api('/close', { discussionId })
        } catch {
          /* the instance is gone either way */
        }
      } else {
        store.set({ status: 'closed', discussion: null, messages: [], live: null })
      }
      if (options.keepTab !== true && sidebar) {
        try {
          sidebar.closeTab?.(TAB_KIND)
        } catch (error) {
          reportFailure('closeTab', error)
        }
      }
    }

    /** The catalogue's display name for a route, when it is known. */
    function modelName(models, route) {
      const list = models?.models?.[route?.provider] ?? []
      return list.find((model) => model.id === route?.model)?.name ?? undefined
    }

    function ToolRow({ t, tool }) {
      const label = tool.status === 'running' ? t('toolRunning') : tool.status === 'error' ? t('toolFailed') : t('toolDone')
      return h(
        'div',
        { className: 'sc-tool', 'data-status': tool.status },
        h('span', { className: 'sc-tool-name' }, tool.name),
        h('span', { className: 'sc-tool-status' }, `· ${label}`),
        tool.text ? h('pre', { className: 'sc-tool-text' }, previewText(tool.text)) : null,
      )
    }

    /** One assistant answer: reasoning, tools, markdown body, usage, actions. */
    function AnswerBlock({ t, message, parentSessionId, notify }) {
      const streaming = message.status === 'streaming'
      const body = message.text?.trim() ? message.text : ''
      return h(
        'div',
        { className: 'sc-answer' },
        message.reasoning ? h(ReasoningRow, { t, text: message.reasoning, streaming }) : null,
        message.tools?.length
          ? h('div', { className: 'sc-tools' }, message.tools.map((tool, index) => h(ToolRow, { t, tool, key: `${tool.name}-${index}` })))
          : null,
        body
          ? h('div', { className: 'sc-md', dangerouslySetInnerHTML: { __html: renderMarkdown(body) } })
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
        h(
          'div',
          { className: 'sc-answer-actions' },
          !streaming && body
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sc-btn',
                  onClick: async () => {
                    const ok = await appendToDraft(parentSessionId, body)
                    notify(ok ? t('toDraftDone') : t('toDraftMissing'))
                  },
                },
                t('toDraft'),
              )
            : null,
          !streaming && body
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'sc-btn',
                  onClick: async () => {
                    try {
                      await navigator.clipboard.writeText(body)
                      notify(t('copied'))
                    } catch (error) {
                      reportFailure('copy', error)
                    }
                  },
                },
                t('copy'),
              )
            : null,
        ),
      )
    }

    /** The panel: header facts, transcript, composer, close confirmation. */
    function DiscussionPanel(props) {
      const t = makeT(props.t)
      const state = useStoreState()
      const [draft, setDraft] = useState('')
      const [notice, setNotice] = useState(null)
      const scrollRef = useRef(null)

      const busy = state.status === 'generating' || state.status === 'stopping'
      const discussion = state.discussion
      const messages = state.messages
      const live = state.live

      useEffect(() => {
        const element = scrollRef.current
        if (element) element.scrollTop = element.scrollHeight
      }, [messages.length, live?.text, live?.reasoning, live?.tools?.length])

      useEffect(() => {
        loadModels()
      }, [])

      // Closing the tab unmounts this body: that is the close, and the instance
      // must not outlive it.
      useEffect(
        () => () => {
          const current = store.get()
          if (current.discussion) closeDiscussion({ keepTab: true })
        },
        [],
      )

      const notify = useCallback((message) => {
        setNotice(message)
        setTimeout(() => setNotice(null), 4000)
      }, [])

      const submit = () => {
        const text = draft.trim()
        if (!text || busy) return
        setDraft('')
        sendQuestion(text)
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
        state.openError && state.status !== 'error' ? h('div', { className: 'sc-notice', 'data-kind': 'error' }, state.openError) : null,
        !discussion && state.status === 'creating'
          ? h(
              'div',
              { className: 'sc-empty' },
              h(
                'svg',
                { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', className: 'sc-spin', 'aria-hidden': true },
                h('path', { d: 'M12 3a9 9 0 1 0 9 9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
              ),
              h('div', { className: 'sc-empty-title' }, t('starting')),
            )
          : null,
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
            )
          : null,
        discussion
          ? h(
              'div',
              { className: 'sc-scroll', ref: scrollRef },
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
                  : h('div', { className: 'sc-turn', key: message.id ?? index }, h(AnswerBlock, { t, message, parentSessionId: state.parentSessionId, notify })),
              ),
              live ? h('div', { className: 'sc-turn' }, h(AnswerBlock, { t, message: { ...live, status: 'streaming' }, parentSessionId: state.parentSessionId, notify })) : null,
            )
          : null,
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
                        title: route ? fill(t('modelTitle'), { provider: route.provider, model: route.model }) : t('model'),
                      },
                      route ? (modelName(state.models, route) ?? route.model) : t('modelInherit'),
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
                            h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.5, fill: 'currentColor' }),
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
                            { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': true },
                            h('path', {
                              d: 'M9 14.5V4M9 4L4.5 8.5M9 4l4.5 4.5',
                              stroke: 'currentColor',
                              strokeWidth: 1.8,
                              strokeLinecap: 'round',
                              strokeLinejoin: 'round',
                            }),
                          ),
                        ),
                  ),
                ),
              ),
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
          ctx.slots.inject('conversation.input.left', () => {
            try {
              window.console?.info?.('[side-chat] registering the composer entry')
            } catch {
              /* console is optional */
            }
            return ctx.slots.register({ name: 'conversation.input.left', id: TAB_ID }, DiscussionEntry)
          }),
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
    }

    return { inject, apply }
  },
})
