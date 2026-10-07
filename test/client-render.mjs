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
    const frame = { discussionId: identity.discussionId, requestId: identity.requestId,
      type: 'done', status: 'done', text: 'session-one-private-answer' }
    return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`)
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
  hooks: { tabInfo: () => ({ tab: { signal: tabSignal, actions: { close: () => closedTabs.push('session-1-tab') } } }) } }
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

await check('tab close asks first, cancel preserves the discussion, confirm clears it', async () => {
  assert.ok(ctx.sidebarRight.closeHandler, 'the close handler is registered')
  const panel = registrations.find((item) => item.options.name === 'sidebar.right.pane.tab')
  assert.throws(() => ctx.sidebarRight.closeHandler.handler('session-1'), /关闭临时会话/)
  let tree = render(panel.component, panelProps)
  assert.match(textOf(tree), /本次会话历史不会保留/)
  assert.equal(calls.some((call) => call.url.endsWith('/close')), false)
  find(tree, (element) => element.type === 'button' && textOf(element) === '继续讨论').props.onClick()
  assert.equal(textOf(render(panel.component, panelProps)).includes('关闭临时会话？'), false)
  assert.throws(() => ctx.sidebarRight.closeHandler.handler('session-1'), /关闭临时会话/)
  tree = render(panel.component, panelProps)
  await find(tree, (element) => element.type === 'button' && textOf(element) === '关闭并清空').props.onClick()
  assert.ok(calls.some((call) => call.url.endsWith('/close')), 'explicit confirmation closes the Host instance')
  assert.deepEqual(closedTabs, ['session-1-tab'], 'uses the real session-bound tab.actions.close API')
  assert.equal(ctx.sidebarRight.closeHandler.handler('session-1'), undefined, 'confirmed removal can proceed')
})

await check('every rendered copy key exists in the dictionary', () => {
  assert.deepEqual([...missingKeys], [], 'no missing locale keys')
})


await check('the bundle has no dangling component reference', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const defined = new Set([...source.matchAll(/function ([A-Z][A-Za-z0-9]+)\(/g)].map((m) => m[1]))
  const used = new Set([...source.matchAll(/\bh\(([A-Z][A-Za-z0-9]+)[,)]/g)].map((m) => m[1]))
  const dangling = [...used].filter((name) => !defined.has(name))
  assert.deepEqual(dangling, [], `h() references components that are not defined: ${dangling.join(', ')}`)
  assert.ok(source.includes('const CSS ='), 'the bundle defines its stylesheet')
})

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}\n`)
process.exit(failures.length === 0 ? 0 : 1)
