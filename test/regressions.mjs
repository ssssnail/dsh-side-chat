import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { selectRoute, captureSnapshot } from '../host/snapshot.js'
import { createReadOnlyToolbox } from '../host/readonly-tools.js'

let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n${error.stack}`) }
}
const wait = () => new Promise((resolve) => setTimeout(resolve, 0))

async function clientHarness() {
  const source = (await readFile(new URL('../client.js', import.meta.url), 'utf8'))
    .replace('return { inject, apply }', 'return { inject, apply, testing: { store, sendQuestion, stopAnswer, openDiscussion, closeDiscussion, requestClose, confirmClose, showDiscussion, setSidebar(value) { sidebar = value } } }')
  let definition
  const streams = [], calls = []
  let openResponse
  let sendResponse
  let closeResponse
  const sandbox = {
    window: { __ModuleLoader__: { load(value) { definition = value } }, console: { error() {} } },
    document: {}, AbortController, TextDecoder, setTimeout, clearTimeout,
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : undefined
      calls.push({ url, body })
      if (url.endsWith('/send') && sendResponse) return sendResponse()
      if (url.endsWith('/send')) return new Response(new ReadableStream({ start(controller) { streams.push({ controller, body }) } }))
      if (url.endsWith('/open') && openResponse) return openResponse()
      if (url.endsWith('/close') && closeResponse) return closeResponse()
      return new Response(JSON.stringify({ ok: true, providers: [], models: {} }))
    },
  }
  vm.runInNewContext(source, sandbox)
  const { testing } = definition.factory(() => ({ createElement() {} }))
  return {
    ...testing, calls, streams,
    setSendResponse: (fn) => { sendResponse = fn },
    setOpenResponse: (fn) => { openResponse = fn },
    setCloseResponse: (fn) => { closeResponse = fn },
    frame(index, data) {
      const stream = streams[index]
      stream.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ discussionId: stream.body.discussionId, requestId: stream.body.requestId, ...data })}\n\n`))
    },
  }
}

console.log('\nside-chat lifecycle and search regressions\n')
await check('button and slash launches share initialization and preserve an active discussion', async () => {
  const client = await clientHarness(), tabs = []
  client.setSidebar({ openTab(kind) { tabs.push(kind) } })
  let accept
  client.setOpenResponse(() => new Promise(resolve => { accept = resolve }))
  const opening = client.showDiscussion('bound-parent')
  client.showDiscussion('bound-parent')
  assert.equal(client.calls.filter(call => call.url.endsWith('/open')).length, 1)
  assert.equal(client.calls[0].body.parentSessionId, 'bound-parent')
  accept(new Response(JSON.stringify({ ok: true, discussion: { discussionId: 'shared', parentSessionId: 'bound-parent' } })))
  await opening
  client.store.set({ status: 'generating', messages: [{ text: 'keep this discussion' }], requestId: 'keep-request' })
  await client.showDiscussion('bound-parent')
  assert.equal(client.store.get().status, 'generating')
  assert.equal(client.store.get().requestId, 'keep-request')
  assert.equal(client.store.get().messages[0].text, 'keep this discussion')
  assert.equal(client.calls.filter(call => call.url.endsWith('/open')).length, 1)
  const before = tabs.length
  client.showDiscussion(undefined)
  assert.equal(tabs.length, before)
})

await check('late stream and finally cannot write into a reopened discussion', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'old' }, parentSessionId: 'old-parent' })
  const old = client.sendQuestion('old question')
  await wait()
  await client.closeDiscussion({ keepTab: true })
  client.store.set({ status: 'idle', discussion: { discussionId: 'new' }, parentSessionId: 'new-parent', messages: [] })
  const current = client.sendQuestion('new question')
  await wait()
  const newRequestId = client.store.get().requestId
  client.frame(0, { type: 'text', text: 'OLD PRIVATE ANSWER' })
  client.frame(0, { type: 'done', status: 'done', text: 'OLD PRIVATE ANSWER' })
  client.streams[0].controller.close()
  await old
  assert.equal(client.store.get().status, 'generating')
  assert.equal(client.store.get().requestId, newRequestId)
  assert.equal(client.store.get().live.text, '')
  client.frame(1, { type: 'text', text: 'new answer' })
  client.frame(1, { type: 'done', status: 'done' })
  client.streams[1].controller.close()
  await current
  assert.equal(client.store.get().messages.length, 2)
  assert.equal(client.store.get().messages[1].text, 'new answer')
})

await check('process notices clear on resumed output and completion, while errors survive', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'notice-test' }, parentSessionId: 'parent' })
  const pending = client.sendQuestion('check')
  await wait()
  client.frame(0, { type: 'notice', message: '正在改用只读工具继续核查。' })
  await wait()
  assert.equal(client.store.get().live.notice, '正在改用只读工具继续核查。')
  client.frame(0, { type: 'reasoning', text: '读取相关材料' })
  await wait()
  assert.equal(client.store.get().live.notice, null)
  client.frame(0, { type: 'notice', message: '正在根据已有信息整理回答。' })
  client.frame(0, { type: 'text', text: '结论' })
  await wait()
  assert.equal(client.store.get().live.notice, null)
  client.frame(0, { type: 'notice', message: '完成前的提示' })
  client.frame(0, { type: 'error', message: '真正的失败' })
  client.frame(0, { type: 'done', status: 'error' })
  client.streams[0].controller.close()
  await pending
  const answer = client.store.get().messages.at(-1)
  assert.equal(answer.notice, null)
  assert.equal(answer.error, '真正的失败')
})

await check('close during initialization disposes a delayed open response', async () => {
  const client = await clientHarness()
  let accept
  client.setOpenResponse(() => new Promise((resolve) => { accept = resolve }))
  const pending = client.openDiscussion('parent')
  await client.closeDiscussion({ keepTab: true })
  accept(new Response(JSON.stringify({ ok: true, discussion: { discussionId: 'late' } })))
  await pending; await wait()
  assert.equal(client.store.get().status, 'closed')
  assert.equal(client.store.get().discussion, null)
  assert.ok(client.calls.some((call) => call.url.endsWith('/close') && call.body.discussionId === 'late'))
})

await check('request identity rejects wrong frames, stop carries the exact request id', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'one' }, parentSessionId: 'parent' })
  const pending = client.sendQuestion('question')
  await wait()
  client.frame(0, { type: 'text', requestId: 'wrong', text: 'wrong answer' })
  await wait()
  assert.equal(client.store.get().live.text, '')
  await client.stopAnswer()
  assert.equal(client.calls.at(-1).body.requestId, client.streams[0].body.requestId)
  client.frame(0, { type: 'done', status: 'stopped' })
  client.streams[0].controller.close()
  await pending
  assert.equal(client.store.get().status, 'idle')
})

await check('a delayed close response cannot close a newly opened tab', async () => {
  const client = await clientHarness()
  const closedTabs = []
  client.store.set({ status: 'idle', discussion: { discussionId: 'old' }, parentSessionId: 'parent' })
  let acceptClose
  client.setCloseResponse(() => new Promise((resolve) => { acceptClose = resolve }))
  const closing = client.closeDiscussion({ closeTab: () => closedTabs.push('old-tab') })
  client.setOpenResponse(() => new Response(JSON.stringify({ ok: true, discussion: { discussionId: 'new' } })))
  await client.openDiscussion('parent')
  acceptClose(new Response(JSON.stringify({ ok: true })))
  assert.equal(await closing, false)
  assert.equal(client.store.get().discussion.discussionId, 'new')
  assert.deepEqual(closedTabs, [])
})

await check('an incomplete SSE stream is an error, not a successful answer', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'one' }, parentSessionId: 'parent' })
  const pending = client.sendQuestion('question')
  await wait()
  client.frame(0, { type: 'text', text: 'partial' })
  client.streams[0].controller.close()
  await pending
  assert.equal(client.store.get().messages.at(-1).status, 'error')
  assert.match(client.store.get().messages.at(-1).error, /提前结束/)
})

await check('confirmation opened during initialization still closes after initialization completes', async () => {
  const client = await clientHarness()
  let accept, removed = 0
  client.setOpenResponse(() => new Promise(resolve => { accept = resolve }))
  const opening = client.openDiscussion('parent')
  client.requestClose()
  const tag = client.store.get().closeRequested.tag
  accept(new Response(JSON.stringify({ ok: true, discussion: { discussionId: 'ready' } })))
  await opening
  assert.equal(client.store.get().tag, tag)
  await client.confirmClose(() => { removed++ })
  assert.equal(client.store.get().status, 'closed')
  assert.equal(removed, 1)
  assert.ok(client.calls.some(c => c.url.endsWith('/close') && c.body.discussionId === 'ready'))
})

await check('expired JSON response retains readable answers and explicit reopen creates a fresh discussion', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'expired' }, parentSessionId: 'parent', messages: [{ role: 'assistant', text: 'old answer' }] })
  client.setSendResponse(() => new Response(JSON.stringify({ ok: false, code: 'discussion-gone', message: 'expired' }), { headers: { 'content-type': 'application/json' } }))
  await client.sendQuestion('question')
  assert.equal(client.store.get().status, 'expired')
  assert.equal(client.store.get().messages[0].text, 'old answer')
  assert.equal(client.calls.filter(c => c.url.endsWith('/open')).length, 0)
  client.setOpenResponse(() => new Response(JSON.stringify({ ok: true, discussion: { discussionId: 'fresh' } })))
  await client.openDiscussion('parent')
  assert.equal(client.store.get().discussion.discussionId, 'fresh')
  assert.equal(client.store.get().messages.length, 0)
  assert.equal(client.calls.filter(c => c.url.endsWith('/send')).length, 1, 'no automatic replay')
})

await check('authentication JSON errors are readable and do not masquerade as truncated SSE', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'one' }, parentSessionId: 'parent' })
  client.setSendResponse(() => new Response(JSON.stringify({ ok: false, code: 'unauthorized', message: '重新打开页面' }), { status: 401, headers: { 'content-type': 'application/json' } }))
  await client.sendQuestion('question')
  assert.equal(client.store.get().messages.at(-1).error, '重新打开页面')
})

await check('completed frames retain step count for the usage line', async () => {
  const client = await clientHarness()
  client.store.set({ status: 'idle', discussion: { discussionId: 'one' }, parentSessionId: 'parent' })
  const pending = client.sendQuestion('question')
  await wait()
  client.frame(0, { type: 'text', text: 'answer' })
  client.frame(0, { type: 'done', status: 'done', steps: 3, stats: { outputTokens: 30, totalMs: 1000 } })
  client.streams[0].controller.close()
  await pending
  assert.equal(client.store.get().lastStats.steps, 3)
})

await check('latest selected model wins without borrowing another model effort', () => {
  const selected = { provider: 'new-provider', model: 'new-model' }
  const route = selectRoute({ get: () => undefined }, {
    ownEvents: () => [{ type: 'model/selection', data: selected }],
    requestHeader: () => ({ config: { provider: 'old-provider', model: 'old-model', reasoningEffort: 'high' } }),
  })
  assert.deepEqual(route, selected)
})

await check('same-model selection preserves its previous reasoning effort', () => {
  const route = selectRoute({ get: () => undefined }, {
    ownEvents: () => [{ type: 'model/selection', data: { provider: 'one', model: 'one' } }],
    requestHeader: () => ({ config: { provider: 'one', model: 'one', reasoningEffort: 'high' } }),
  })
  assert.equal(route.reasoningEffort, 'high')
})

await check('no completed turn means no in-flight history is inherited', async () => {
  const parent = {
    header: {}, snapshotEvents: () => [{ seq: 0, type: 'user/message' }],
    ownEvents: () => [], surface: { nodes: [0] }, eventAt: () => ({}),
    deriveEventMessage: () => ({ role: 'user', content: [{ type: 'text', text: 'unfinished' }] }),
  }
  const snapshot = await captureSnapshot({ get: (name) => name === 'sessions' ? { get: () => parent } : undefined }, 'parent')
  assert.deepEqual(snapshot.messages, [])
  assert.equal(snapshot.empty, true)
  assert.equal(snapshot.excludedInflight, true)
})

async function searchBox(value, filename = 'test.txt') {
  const file = { targetKey: '/ws/test.txt', displayPath: `/ws/${filename}` }
  const fs = {
    resolve: async (path) => path === '/ws' ? { targetKey: '/ws', displayPath: '/ws' } : file,
    contains: () => true, stat: async () => ({ type: 'file', size: value.length }), readText: async () => value,
  }
  return createReadOnlyToolbox({ get: () => fs }, '/ws')
}
await check('normal grep returns matching lines and invalid regex reports an error', async () => {
  const box = await searchBox('hello\nworld\n')
  const result = await box.execute('grep', '{"path":"test.txt","pattern":"hello"}')
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /1:hello/)
  const invalid = await box.execute('grep', '{"path":"test.txt","pattern":"["}')
  assert.equal(invalid.isError, true)
  assert.match(invalid.text, /正则表达式无效/)
})

await check('glob and grep include retain basename, recursive and brace matching', async () => {
  const box = await searchBox('hello', 'src/app.ts')
  for (const pattern of ['*.ts', '**/*.ts', 'src/?pp.{js,ts}']) {
    const result = await box.execute('glob', JSON.stringify({ path: 'test.txt', pattern }))
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /src\/app\.ts/)
  }
  const include = await box.execute('grep', JSON.stringify({ path: 'test.txt', pattern: 'hello', include: '*.ts' }))
  assert.match(include.text, /1:hello/)
  const excluded = await box.execute('grep', JSON.stringify({ path: 'test.txt', pattern: 'hello', include: '*.js' }))
  assert.equal(excluded.text, '没有匹配。')
})

for (const tool of ['glob', 'grep']) await check(`pathological ${tool === 'glob' ? 'glob' : 'grep include'} matching cannot block Host cancellation`, async () => {
  const box = await searchBox('hello', 'a'.repeat(48) + '.txt')
  const pattern = 'a*'.repeat(24) + 'b'
  const args = tool === 'glob' ? { path: 'test.txt', pattern } : { path: 'test.txt', pattern: 'hello', include: pattern }
  const controller = new AbortController()
  const started = Date.now()
  let ticked = false
  const timer = setTimeout(() => { ticked = true; controller.abort(new Error('cancel glob')) }, 100)
  try {
    const result = await box.execute(tool, JSON.stringify(args), controller.signal)
    assert.equal(result.isError, true)
    assert.equal(ticked, true)
    assert.ok(Date.now() - started < 800, 'glob matching must not block the cancellation timer')
  } finally { clearTimeout(timer) }
})

await check('pathological regex is cancellable while the Host event loop stays responsive', async () => {
  const box = await searchBox('a'.repeat(32) + '!')
  const controller = new AbortController()
  let ticked = false
  const started = Date.now()
  const timer = setTimeout(() => { ticked = true; controller.abort(new Error('test cancellation')) }, 100)
  try {
    const result = await box.execute('grep', '{"path":"test.txt","pattern":"(a+)+$"}', controller.signal)
    assert.equal(result.isError, true)
    assert.equal(ticked, true)
    assert.ok(Date.now() - started < 800, 'cancellation must not wait for the regex')
  } finally { clearTimeout(timer) }
})

await check('pathological regex also has a hard timeout without user cancellation', async () => {
  const box = await searchBox('a'.repeat(32) + '!')
  const started = Date.now()
  const result = await box.execute('grep', '{"path":"test.txt","pattern":"(a+)+$"}')
  assert.equal(result.isError, true)
  assert.match(result.text, /匹配超时/)
  assert.ok(Date.now() - started < 2500)
})

process.exitCode = failures ? 1 : 0
