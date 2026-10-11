/**
 * Client-half test for the panel implementation.
 *
 * The panel renders its own transcript from the discussion event stream, so
 * these checks cover the wiring (entry, tab type, panel, close confirmation) and
 * that the panel mounts without throwing. No React is on disk, so a minimal hook
 * runtime drives the real components.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

let hookSlots = []
let hookIndex = 0
let pendingEffects = []
const slotsByComponent = new Map()

function useState(initial) {
  const slots = hookSlots
  const index = hookIndex++
  if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
  return [
    slots[index],
    (next) => {
      slots[index] = typeof next === 'function' ? next(slots[index]) : next
    },
  ]
}
function useRef(initial) {
  const slots = hookSlots
  const index = hookIndex++
  if (!(index in slots)) slots[index] = { current: initial }
  return slots[index]
}
function useCallback(fn, deps) {
  const slots = hookSlots
  const index = hookIndex++
  const previous = slots[index]
  if (!previous || !deps || deps.some((value, position) => value !== previous.deps[position])) slots[index] = { fn, deps }
  return slots[index].fn
}
function useEffect(fn, deps) {
  const slots = hookSlots
  const index = hookIndex++
  const previous = slots[index]
  const changed = !previous || !deps || deps.some((value, position) => value !== previous.deps[position])
  slots[index] = { deps }
  if (changed) pendingEffects.push(fn)
}

function useMemo(factory, deps) {
  const slots = hookSlots
  const index = hookIndex++
  const previous = slots[index]
  if (!previous || !deps || deps.some((value, position) => value !== previous.deps[position])) slots[index] = { value: factory(), deps }
  return slots[index].value
}

const React = {
  createElement(type, props, ...children) {
    const resolved = { ...(props ?? {}) }
    if (children.length === 1) resolved.children = children[0]
    else if (children.length > 1) resolved.children = children
    return { type, props: resolved }
  },
  Fragment: Symbol('Fragment'),
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
}

const markdownCalls = []
function MarkdownText(props) {
  markdownCalls.push(props)
  return React.createElement('div', { 'data-native-markdown': true }, props.text)
}

let captured = null
globalThis.window = {
  __ModuleLoader__: { load(definition) { captured = definition } },
  addEventListener() {},
  removeEventListener() {},
  console: { error() {}, info() {} },
}
globalThis.document = { addEventListener() {}, removeEventListener() {}, activeElement: null }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async () => {} } } })

const calls = []
const copiedTexts = []
navigator.clipboard.writeText = async (text) => { copiedTexts.push(text) }
let sendResponse = null
let responseFrames = [{ type: 'done', status: 'done', text: 'session-one-private-answer' }]
let openResult = { ok: false, message: 'no script' }

globalThis.fetch = async (url, options = {}) => {
  calls.push({ url, body: options.body ? JSON.parse(options.body) : undefined })
  if (url.endsWith('/open')) return new Response(JSON.stringify(openResult), { status: 200 })
  if (url.endsWith('/models')) {
    return new Response(
      JSON.stringify({ ok: true, providers: [{ id: 'fake', name: 'Fake' }], models: { fake: [{ id: 'fake-1', name: 'Fake One' }] } }),
      { status: 200 },
    )
  }
  if (url.endsWith('/send')) {
    const identity = JSON.parse(options.body)
    if (sendResponse) return sendResponse(identity)
    return new Response(responseFrames.map((frame) => `data: ${JSON.stringify({ ...frame, discussionId: identity.discussionId, requestId: identity.requestId })}\n\n`).join('') + 'data: [DONE]\n\n')
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}

await import('../client.js')
assert.ok(captured, 'client bundle registered a factory')

const registrations = []
const tabTypes = []
const dictionaries = {}
const openedTabs = []
const closedTabs = []
const tabSignal = new AbortController().signal

const ctx = {
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  locale: {
    register(namespace, dicts) { dictionaries[namespace] = dicts },
    bind: (namespace) => (key) => dictionaries[namespace]?.zh?.[key] ?? key,
  },
  slots: {
    inject(key, callback) { callback(); return () => {} },
    register(options, component) { registrations.push({ options, component }); return () => {} },
  },
  sidebarRight: {
    openTab(kind) { openedTabs.push(kind) },
    registerCloseHandler(kind, handler) { this.closeHandler = { kind, handler }; return () => {} },
  },
  sidebarRightTabs: { register(definition) { tabTypes.push(definition); return () => {} } },
}

const plugin = captured.factory((name) => {
  if (name === 'react') return React
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MarkdownText }
  throw new Error(`unexpected require(${name})`)
})
plugin.apply(ctx)

function expand(element) {
  if (element === null || element === undefined || typeof element !== 'object') return element
  if (Array.isArray(element)) return element.map(expand)
  if (typeof element.type === 'function') {
    const previousSlots = hookSlots
    const previousIndex = hookIndex
    if (!slotsByComponent.has(element.type)) slotsByComponent.set(element.type, [])
    hookSlots = slotsByComponent.get(element.type)
    hookIndex = 0
    const rendered = expand(element.type(element.props))
    hookSlots = previousSlots
    hookIndex = previousIndex
    return rendered
  }
  const children = element.props?.children
  return { ...element, props: { ...element.props, children: expand(children) } }
}

function render(component, props) {
  if (!slotsByComponent.has(component)) slotsByComponent.set(component, [])
  hookSlots = slotsByComponent.get(component)
  hookIndex = 0
  pendingEffects = []
  const tree = expand({ type: component, props })
  for (const effect of pendingEffects) effect()
  return tree
}

function find(element, predicate) {
  if (element === null || typeof element !== 'object') return undefined
  if (Array.isArray(element)) {
    for (const child of element) {
      const hit = find(child, predicate)
      if (hit) return hit
    }
    return undefined
  }
  if (predicate(element)) return element
  return find(element.props?.children, predicate)
}

function textOf(element) {
  if (element === null || element === undefined || element === false) return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  if (Array.isArray(element)) return element.map(textOf).join('')
  if (typeof element === 'object') return textOf(element.props?.children)
  return ''
}

const missingKeys = new Set()
const fill = (template, values) =>
  String(template).replace(/\{(\w+)\}/g, (_, key) => (values?.[key] === undefined ? '' : String(values[key])))
const translate = (key, values) => {
  const dict = dictionaries.sideChat?.zh
  if (!dict || !(key in dict)) {
    missingKeys.add(key)
    return key
  }
  return values ? fill(dict[key], values) : dict[key]
}

const failures = []
const panelProps = { sessionId: 'session-1', t: translate,
  useTabInfo: () => ({ tab: { signal: tabSignal, actions: { close: () => {
    ctx.sidebarRight.closeHandler.handler('session-1')
    closedTabs.push('session-1-tab')
  } } } }) }
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

console.log('\nside-chat client panel\n')

await check('declares the services the panel needs', () => {
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'])
})

await check('registers the entry, the tab type and the panel', () => {
  assert.ok(tabTypes.some((entry) => entry.kind === 'side-chat'), 'the tab type')
  assert.ok(registrations.some((item) => item.options.name === 'conversation.input.left'), 'the entry')
  assert.ok(registrations.some((item) => item.options.name === 'sidebar.right.pane.tab'), 'the panel body')
})

await check('the entry opens the tab and creates the instance', async () => {
  openResult = {
    ok: true,
    discussion: {
      discussionId: 'd1',
      sessionId: 'discussion-1',
      parentSessionId: 'session-1',
      parentLabel: '迁移 build 配置',
      snapshotTime: 1_700_000_000_000,
      completedTurns: 3,
      excludedInflight: true,
      empty: false,
      truncated: false,
      omittedMessages: 0,
      estimatedTokens: 12_000,
      tools: ['read', 'glob', 'grep'],
      workspace: '/tmp/ws',
      route: { provider: 'fake', model: 'fake-1' },
    },
  }
  const entry = registrations.find((item) => item.options.name === 'conversation.input.left')
  const tree = render(entry.component, {
    sessionId: 'session-1',
    inputActions: { setDraft() {} },
    useInput: (selector) => selector({ draft: '' }),
    t: translate,
  })
  const button = find(tree, (element) => element.type === 'button')
  assert.equal(button.props.title, '临时会话')
  button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(openedTabs, ['side-chat'])
  assert.ok(calls.some((call) => call.url.endsWith('/open')), 'the instance was created')
})

await check('the panel renders the prepared discussion', () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  const tree = render(panel.component, panelProps)
  const text = textOf(tree)
  assert.match(text, /临时会话/)
  assert.match(text, /这是一个临时会话，关闭后会清除所有信息/)
  assert.equal(text.includes('read · glob · grep'), false, 'no tools line in the chrome')
  assert.ok(find(tree, (element) => element.props?.className === 'sc-input'), 'the composer input')
})

await check('empty statistics use the selected language', () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  const english = key => dictionaries.sideChat.en[key] ?? key
  const englishTree = render(panel.component, { ...panelProps, t: english })
  const englishStats = textOf(find(englishTree, element => element.props?.className === 'sc-statsline'))
  assert.equal(englishStats, '0 turns 0 steps · 0 tok · 0 tok/s · Cache hit 0%')
  const chineseTree = render(panel.component, panelProps)
  assert.match(textOf(find(chineseTree, element => element.props?.className === 'sc-statsline')), /^0 轮 0 步/)
})

await check('multiline input grows, caps its height and shrinks after clearing', () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  let tree = render(panel.component, panelProps)
  const geometry = { style: {}, scrollHeight: 112, focus() {} }
  find(tree, element => element.type === 'textarea').props.ref.current = geometry
  find(tree, element => element.type === 'textarea').props.onChange({ target: { value: 'first\nsecond\nthird' } })
  tree = render(panel.component, panelProps)
  assert.equal(geometry.style.height, '112px')
  geometry.scrollHeight = 300
  find(tree, element => element.type === 'textarea').props.onChange({ target: { value: 'many lines' } })
  tree = render(panel.component, panelProps)
  assert.equal(geometry.style.height, '180px')
  geometry.scrollHeight = 20
  find(tree, element => element.type === 'textarea').props.onChange({ target: { value: '' } })
  render(panel.component, panelProps)
  assert.equal(geometry.style.height, '36px')
})

await check('another session tab cannot display or control the discussion transcript', async () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  let tree = render(panel.component, panelProps)
  find(tree, (element) => element.type === 'textarea').props.onChange({ target: { value: 'session-one-private-question' } })
  tree = render(panel.component, panelProps)
  find(tree, (element) => element.type === 'button' && element.props?.title === '发送').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.match(textOf(render(panel.component, panelProps)), /session-one-private-question/)
  const another = render(panel.component, { ...panelProps, sessionId: 'session-2' })
  assert.equal(textOf(another).includes('session-one-private'), false)
  assert.equal(find(another, (element) => element.type === 'textarea'), undefined)
  assert.equal(ctx.sidebarRight.closeHandler.handler('session-2'), undefined)
})

await check('completed-turn statistics remain localized in English', () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  const english = key => dictionaries.sideChat.en[key] ?? key
  const tree = render(panel.component, { ...panelProps, t: english })
  const stats = textOf(find(tree, element => element.props?.className === 'sc-statsline'))
  assert.match(stats, /^1 turns 0 steps/)
  assert.doesNotMatch(stats, /轮|步/)
  render(panel.component, panelProps)
})

await check('native Markdown receives raw text, completed status and stable localized labels', async () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  const markdown = '# 标题\n\n| 项目 | 状态 |\n| --- | --- |\n| **检查** | 完成 |\n\n```js\nconst answer = 42\n```'
  responseFrames = [{ type: 'text', text: markdown }, { type: 'done', status: 'done' }]
  let tree = render(panel.component, panelProps)
  find(tree, (element) => element.type === 'textarea').props.onChange({ target: { value: 'render-markdown' } })
  tree = render(panel.component, panelProps)
  find(tree, (element) => element.type === 'button' && element.props?.title === '发送').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 20))
  tree = render(panel.component, panelProps)
  const rendered = markdownCalls.at(-1)
  assert.equal(rendered.text, markdown, 'no escaping or regex rewriting before the native renderer')
  assert.equal(rendered.streaming, false)
  assert.deepEqual(rendered.labels, { code: { copyLabel: '复制', copiedLabel: '已复制', toolbarLabels: { codeLabel: '代码', wrapLabel: '自动换行', unwrapLabel: '取消自动换行' } }, footnotes: '脚注' })
  render(panel.component, panelProps)
  assert.equal(markdownCalls.at(-1).labels, rendered.labels, 'unchanged locale preserves renderer cache')
  const buttons = []
  function collect(element) {
    if (!element || typeof element !== 'object') return
    if (Array.isArray(element)) return element.forEach(collect)
    if (element.type === 'button' && element.props?.['data-action'] === 'copy') buttons.push(element)
    collect(element.props?.children)
  }
  collect(tree)
  await buttons.at(-1).props.onClick()
  assert.equal(copiedTexts.at(-1), markdown, 'copy preserves the original Markdown')
})

await check('icon-only actions retain accessible labels and import one answer without sending', async () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  const entry = registrations.find((item) => item.options.name === 'conversation.input.left')
  const writes = []
  render(entry.component, { sessionId: 'session-1', inputActions: { setDraft(text) { writes.push(text) } },
    useInput: selector => selector({ draft: '原有主会话草稿' }), t: translate })
  let tree = render(panel.component, panelProps)
  const toolbar = find(tree, element => element.props?.className === 'sc-answer-toolbar')
  assert.equal(toolbar.props.role, 'group')
  assert.equal(toolbar.props['aria-label'], '回答操作')
  const button = find(tree, element => element.props?.['data-action'] === 'draft')
  assert.equal(button.props['aria-label'], '导入到主会话')
  assert.match(button.props.title, /草稿.*不会自动发送/)
  assert.ok(find(button, element => element.type === 'svg'), 'the action has a visible icon')
  assert.equal(textOf(button), '', 'no visible text or pill label')
  assert.equal(textOf(find(tree, element => element.props?.['data-action'] === 'copy')), '', 'copy is also icon-only')
  const before = calls.filter(call => call.url.endsWith('/send')).length
  await Promise.all([button.props.onClick(), button.props.onClick()])
  assert.equal(writes.length, 1, 'rapid double clicks do not duplicate the draft insertion')
  assert.equal(writes[0], '原有主会话草稿\n\n---\n\nsession-one-private-answer', 'imports the clicked answer, not the whole discussion')
  assert.equal(calls.filter(call => call.url.endsWith('/send')).length, before, 'import never sends a message')
  tree = render(panel.component, panelProps)
  const imported = find(tree, element => element.props?.['data-action'] === 'draft')
  assert.equal(imported.props['data-feedback'], true)
  assert.equal(textOf(imported), '', 'feedback does not expand the icon button')
  assert.equal(imported.props.title, '已加入草稿')
  assert.match(textOf(tree), /已加入草稿/)
})

await check('clipboard failure is visible and leaves answer actions usable', async () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  const original = navigator.clipboard.writeText
  navigator.clipboard.writeText = async () => { throw new Error('clipboard denied') }
  try {
    const tree = render(panel.component, panelProps)
    await find(tree, element => element.props?.['data-action'] === 'copy').props.onClick()
    const after = render(panel.component, panelProps)
    assert.match(textOf(after), /复制失败，请重试/)
    assert.equal(find(after, element => element.props?.['data-action'] === 'copy').props.disabled, false)
  } finally { navigator.clipboard.writeText = original }
})

await check('streaming respects reader scroll intent and tool details default to collapsed', async () => {
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  let tree = render(panel.component, panelProps)
  const geometry = { scrollHeight: 1400, clientHeight: 300, scrollTop: 0 }
  find(tree, (element) => element.props?.className === 'sc-scroll').props.ref.current = geometry
  let enqueue, end
  sendResponse = (identity) => new Response(new ReadableStream({ start(controller) {
    enqueue = (frame) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ ...frame, discussionId: identity.discussionId, requestId: identity.requestId })}\n\n`))
    end = () => controller.close()
  } }))
  find(tree, (element) => element.type === 'textarea').props.onChange({ target: { value: 'scroll-test' } })
  tree = render(panel.component, panelProps)
  find(tree, (element) => element.type === 'button' && element.props?.title === '发送').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))
  tree = render(panel.component, panelProps)
  assert.equal(geometry.scrollTop, geometry.scrollHeight, 'new turn starts following')
  let scroller = find(tree, (element) => element.props?.className === 'sc-scroll')
  scroller.props.onWheel({ deltaY: -100 })
  geometry.scrollTop = 500
  scroller.props.onScroll({ currentTarget: geometry })
  enqueue({ type: 'text', text: 'streaming-body' })
  enqueue({ type: 'tool', name: 'bash', status: 'running' })
  enqueue({ type: 'tool', name: 'bash', status: 'error', text: '只读范围拒绝' })
  enqueue({ type: 'notice', message: '过程提示' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  geometry.scrollHeight = 1800
  tree = render(panel.component, panelProps)
  assert.equal(geometry.scrollTop, 500, 'new tokens and notices must not drag reader down')
  const tool = find(tree, (element) => element.type === 'details' && element.props?.className.includes('sc-tool-details'))
  assert.ok(tool)
  assert.equal(tool.props.open, undefined, 'tool result starts collapsed')
  assert.equal(tool.props['data-status'], 'error', 'failure is still visible in the summary')
  const latest = find(tree, element => element.props?.className === 'sc-latest')
  assert.ok(latest, 'scrolling away exposes the return button')
  latest.props.onClick()
  tree = render(panel.component, panelProps)
  assert.equal(geometry.scrollTop, geometry.scrollHeight)
  assert.equal(find(tree, element => element.props?.className === 'sc-latest'), undefined)
  enqueue({ type: 'text', text: '-continued' })
  await new Promise((resolve) => setTimeout(resolve, 0))
  geometry.scrollHeight = 2000
  tree = render(panel.component, panelProps)
  assert.equal(geometry.scrollTop, geometry.scrollHeight, 'returning to bottom resumes following')
  assert.equal(textOf(tree).includes('过程提示'), false)
  enqueue({ type: 'done', status: 'done' }); end()
  await new Promise((resolve) => setTimeout(resolve, 10))
  sendResponse = null
})

await check('query prose folds into exploration notes and actions use the final answer only', async () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  responseFrames = [
    { type: 'step', step: 1 }, { type: 'text', text: '我先读取配置。' },
    { type: 'step', step: 2 }, { type: 'text', text: '**最终结论**' },
    { type: 'done', status: 'done', text: '**最终结论**', process: ['我先读取配置。'] },
  ]
  let tree = render(panel.component, panelProps)
  find(tree, element => element.type === 'textarea').props.onChange({ target: { value: 'final-only' } })
  tree = render(panel.component, panelProps)
  find(tree, element => element.type === 'button' && element.props.title === '发送').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = render(panel.component, panelProps)
  const process = find(tree, element => element.props?.className === 'sc-process')
  assert.ok(process)
  assert.equal(process.props.open, undefined)
  assert.match(textOf(process), /我先读取配置/)
  const all = []
  function collect(element) {
    if (!element || typeof element !== 'object') return
    if (Array.isArray(element)) return element.forEach(collect)
    if (element.props?.['data-action'] === 'copy') all.push(element)
    collect(element.props?.children)
  }
  collect(tree)
  await all.at(-1).props.onClick()
  assert.equal(copiedTexts.at(-1), '**最终结论**')
})

await check('failed answers can return the original question to the input without sending', async () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  responseFrames = [{ type: 'error', message: '服务暂不可用' }, { type: 'done', status: 'error', text: '' }]
  let tree = render(panel.component, panelProps)
  find(tree, element => element.type === 'textarea').props.onChange({ target: { value: 'recover-this-question' } })
  tree = render(panel.component, panelProps)
  find(tree, element => element.type === 'button' && element.props.title === '发送').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = render(panel.component, panelProps)
  const before = calls.filter(call => call.url.endsWith('/send')).length
  find(tree, element => element.type === 'button' && textOf(element) === '重新编辑问题').props.onClick()
  tree = render(panel.component, panelProps)
  assert.equal(find(tree, element => element.type === 'textarea').props.value, 'recover-this-question')
  assert.equal(calls.filter(call => call.url.endsWith('/send')).length, before)
})

await check('real useTabInfo injection: cancel preserves the tab, confirm clears and removes it', async () => {
  assert.ok(ctx.sidebarRight.closeHandler, 'the close handler is registered')
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  assert.throws(() => ctx.sidebarRight.closeHandler.handler('session-1'), /关闭临时会话/)
  let tree = render(panel.component, panelProps)
  assert.match(textOf(tree), /本次会话历史不会保留/)
  assert.equal(calls.some((call) => call.url.endsWith('/close')), false)
  find(tree, (element) => element.type === 'button' && textOf(element) === '继续讨论').props.onClick()
  assert.equal(closedTabs.length, 0, 'cancel must not remove the tab')
  assert.equal(textOf(render(panel.component, panelProps)).includes('关闭临时会话？'), false)
  assert.throws(() => ctx.sidebarRight.closeHandler.handler('session-1'), /关闭临时会话/)
  tree = render(panel.component, panelProps)
  await find(tree, (element) => element.type === 'button' && textOf(element) === '关闭并清空').props.onClick()
  assert.ok(calls.some((call) => call.url.endsWith('/close')), 'explicit confirmation closes the Host instance')
  assert.deepEqual(closedTabs, ['session-1-tab'], 'uses the real session-bound tab.actions.close API')
  assert.equal(ctx.sidebarRight.closeHandler.handler('session-1'), undefined, 'confirmed removal can proceed')
})

await check('lost state offers a new discussion and failed opening offers retry', async () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  let tree = render(panel.component, panelProps)
  tree = render(panel.component, panelProps)
  assert.equal(find(tree, element => element.type === 'textarea'), undefined)
  assert.match(textOf(tree), /历史不会保留/)
  const prepared = openResult
  openResult = { ok: false, message: '临时连接失败' }
  await find(tree, element => element.type === 'button' && textOf(element) === '重新打开讨论').props.onClick()
  tree = render(panel.component, panelProps)
  assert.match(textOf(tree), /临时连接失败/)
  const retry = find(tree, element => element.type === 'button' && textOf(element) === '重试打开')
  assert.ok(retry)
  openResult = { ...prepared, discussion: { ...prepared.discussion, discussionId: 'd2' } }
  await retry.props.onClick()
  tree = render(panel.component, panelProps)
  tree = render(panel.component, panelProps)
  assert.equal(find(tree, element => element.type === 'textarea').props.value, '', 'a fresh discussion does not retain the old draft')
  assert.equal(textOf(tree).includes('recover-this-question'), false, 'old history has been cleared')
})

await check('expired panel renders recovery, disables send and opens a fresh instance', async () => {
  const panel = registrations.find(item => item.options.name === 'sidebar.right.pane.tab')
  sendResponse = () => new Response(JSON.stringify({ ok: false, code: 'discussion-gone', message: 'expired' }), { headers: { 'content-type': 'application/json' } })
  let tree = render(panel.component, panelProps)
  find(tree, element => element.type === 'textarea').props.onChange({ target: { value: 'expired question' } })
  tree = render(panel.component, panelProps)
  find(tree, element => element.type === 'button' && element.props.title === '发送').props.onClick()
  await new Promise(resolve => setTimeout(resolve, 20))
  tree = render(panel.component, panelProps)
  assert.match(textOf(tree), /临时讨论已过期/)
  assert.equal(find(tree, element => element.type === 'button' && element.props.title === '发送').props.disabled, true)
  const before = calls.filter(call => call.url.endsWith('/open')).length
  openResult = { ...openResult, discussion: { ...openResult.discussion, discussionId: 'after-expiry' } }
  await find(tree, element => element.type === 'button' && textOf(element) === '重新打开讨论').props.onClick()
  tree = render(panel.component, panelProps)
  assert.equal(textOf(tree).includes('临时讨论已过期'), false)
  assert.equal(calls.filter(call => call.url.endsWith('/open')).length, before + 1)
  sendResponse = null
})

await check('every rendered copy key exists in the dictionary', () => {
  assert.deepEqual([...missingKeys], [], 'no missing locale keys')
})


await check('the bundle has no dangling component reference', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const defined = new Set([...source.matchAll(/function ([A-Z][A-Za-z0-9]+)\(/g)].map((m) => m[1]))
  assert.match(source, /const \{ MarkdownText \} = require\('@deepseek-ai\/dsh-client-ui-primitives'\)/, 'uses the public renderer module')
  defined.add('MarkdownText')
  const used = new Set([...source.matchAll(/\bh\(([A-Z][A-Za-z0-9]+)[,)]/g)].map((m) => m[1]))
  const dangling = [...used].filter((name) => !defined.has(name))
  assert.deepEqual(dangling, [], `h() references components that are not defined: ${dangling.join(', ')}`)
  assert.ok(source.includes('const CSS ='), 'the bundle defines its stylesheet')
})

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}\n`)
process.exit(failures.length === 0 ? 0 : 1)
