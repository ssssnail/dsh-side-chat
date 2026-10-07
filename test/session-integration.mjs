import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createDiscussionRuntime } from '../host/runtime.js'
import { captureSnapshot } from '../host/snapshot.js'
import { FINAL_ANSWER_INSTRUCTION } from '../host/prompt.js'

const HARNESS = process.env.DSH_HARNESS_DIR
  ?? '/Users/snail/.local/share/pi-node/node-v22.23.2-darwin-x64/lib/node_modules/@deepseek-ai/dsh'
const require = createRequire(`${HARNESS}/package.json`)
const { Context } = require('@deepseek-ai/cordis')
const { SessionStore } = require('@deepseek-ai/dsh-session')
const { projectToolUpdates } = require('@deepseek-ai/dsh-llm')
const { DeepSeekAdapter } = require('@deepseek-ai/dsh-llm-deepseek')
let failures = 0
async function check(name, fn) {
  try { await fn(); console.log(`  ok   ${name}`) }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n${error.stack}`) }
}
const block = (text) => ({ type: 'text', text })
const message = (role, text) => ({ id: `id-${text}`, role, content: [block(text)], source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'fake', model: 'fake' } })
async function* reply(text) {
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: block(text) }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
function setup({ empty = false } = {}) {
  const sessions = new SessionStore(new Context())
  const parent = sessions.prepare('parent', { meta: { cwd: '/private/tmp' } })
  sessions.enter(parent); sessions.announce(parent)
  parent.append('turn/start', { turn: 1 })
  parent.append('user/message', message('user', 'parent-question'), { surfaceOp: 'append' })
  if (!empty) {
    parent.append('assistant/message', { turn: 1, step: 1, message: message('assistant', 'parent-answer'), stream: [] }, { surfaceOp: 'append' })
    parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  const prepared = new Map()
  const prepare = sessions.prepare.bind(sessions)
  sessions.prepare = (...args) => {
    const record = prepare(...args)
    prepared.set(record.id, record)
    return record
  }
  const requests = [], logs = []
  const llm = {
    resolveModelInfo: async () => ({}),
    stream(request) { requests.push(request); return reply(`reply-${requests.length}`) },
  }
  const ctx = {
    sessions, llm, emit() {},
    get(name) { return { sessions, llm, agentDefaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) } }[name] },
  }
  const runtime = createDiscussionRuntime(ctx, { tools: false, log: (event) => logs.push(event) })
  return { sessions, prepared, parent, requests, logs, llm, ctx, runtime }
}
const hasText = (messages, text) => messages.some((entry) => entry.content?.some((item) => item.text?.includes(text)))
async function threeTurns(runtime, id) {
  for (let index = 0; index < 3; index += 1) await runtime.send({ discussionId: id, requestId: `request-${index}`, text: `unique-question-${index}` })
}

console.log('\nside-chat with the actual installed SessionStore (no model or persistence)\n')
await check('leading metadata remains valid in a real seed and the main session is untouched', async () => {
  const s = setup(), original = s.parent.snapshotEvents()
  const view = await s.runtime.open({ parentSessionId: 'parent' })
  const child = s.prepared.get(view.sessionId)
  assert.ok(child, 'the advertised Session must exist')
  assert.equal(child.inheritedEventCount, original.length)
  assert.deepEqual(child.snapshotEvents(0, original.length), original)
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'one', text: 'discussion-question' })
  assert.ok(hasText(s.requests[0].messages, 'parent-question'))
  assert.equal(s.requests[0].sessionId, undefined)
  assert.equal(s.logs.some((event) => ['session-failed', 'append'].includes(event.stage)), false)
  assert.deepEqual(s.parent.snapshotEvents(), original)
  s.runtime.closeAll()
  assert.equal(s.sessions.get(view.sessionId), undefined)
})

await check('private discussions never appear in the real shared SessionStore catalog', async () => {
  const s = setup()
  const before = s.sessions.list().map(record => record.id)
  const view = await s.runtime.open({ parentSessionId: 'parent' })
  assert.equal(s.sessions.get(view.sessionId), undefined)
  assert.deepEqual(s.sessions.list().map(record => record.id), before)
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'one', text: 'question' })
  assert.ok(s.prepared.get(view.sessionId).ownEvents().some(event => event.type === 'assistant/message'))
  assert.deepEqual(s.sessions.list().map(record => record.id), before)
  s.runtime.closeAll()
  assert.equal(s.runtime.get(view.discussionId), undefined)
})

await check('opening never calls the model and records initialization stages', async () => {
  const s = setup()
  const view = await s.runtime.open({ parentSessionId: 'parent' })
  assert.equal(s.requests.length, 0)
  const timing = s.logs.find(event => event.stage === 'open')
  for (const field of ['snapshotMs', 'toolboxMs', 'sessionMs', 'totalMs']) {
    assert.ok(Number.isFinite(timing[field]) && timing[field] >= 0, field)
  }
  console.log(`       initialization: ${timing.totalMs}ms (offline fixture, not production latency)`)
  s.runtime.close(view.discussionId)
})

await check('an empty inherited prefix creates a valid Session without leaking an unfinished turn', async () => {
  const s = setup({ empty: true })
  const view = await s.runtime.open({ parentSessionId: 'parent' })
  assert.ok(s.prepared.get(view.sessionId))
  assert.equal(view.empty, true)
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'one', text: 'discussion-question' })
  assert.equal(hasText(s.requests[0].messages, 'parent-question'), false)
  s.runtime.closeAll()
})

await check('snapshot budget trimming affects actual requests without invalidating the seed', async () => {
  const s = setup()
  s.llm.resolveModelInfo = async () => ({ context: { contextWindow: 8000 }, defaultMaxTokens: 100 })
  const previousGet = s.ctx.get
  s.ctx.get = (name) => name === 'tokenMeter' ? { estimateMessage: () => 4500 } : previousGet(name)
  const snapshot = await captureSnapshot(s.ctx, 'parent')
  assert.equal(snapshot.truncated, true)
  const view = await s.runtime.open({ parentSessionId: 'parent' })
  assert.ok(s.prepared.get(view.sessionId))
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'one', text: 'discussion-question' })
  assert.deepEqual(s.requests[0].messages.slice(0, snapshot.messages.length), snapshot.messages)
  assert.equal(hasText(s.requests[0].messages, 'parent-question'), false)
  s.runtime.closeAll()
})

await check('a fork with no own completed turns still inherits its completed parent history', async () => {
  const s = setup(), fork = s.sessions.fork(s.parent)
  const view = await s.runtime.open({ parentSessionId: fork.id })
  assert.equal(view.empty, false)
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'one', text: 'discussion-question' })
  assert.ok(hasText(s.requests[0].messages, 'parent-question'))
  const child = s.prepared.get(view.sessionId)
  const start = child.ownEvents().find((event) => event.type === 'turn/start')
  assert.equal(start.data.turn, 2)
  s.runtime.closeAll()
})

await check('compact replaces older request history with the summary in Session mode', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  assert.ok(s.prepared.get(view.sessionId))
  await threeTurns(s.runtime, view.discussionId)
  assert.equal((await s.runtime.compact(view.discussionId)).compacted, true)
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'after', text: 'after-compaction' })
  const messages = s.requests.at(-1).messages
  assert.equal(hasText(messages, 'unique-question-0'), false)
  assert.ok(hasText(messages, '较早的临时讨论摘要'))
  assert.ok(hasText(messages, 'unique-question-1'))
  assert.ok(hasText(messages, 'parent-question'))
  s.runtime.closeAll()
})

await check('compaction serializes with send, and closing cancels its own model request', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  await threeTurns(s.runtime, view.discussionId)
  let signal
  s.llm.stream = async function* (request) {
    signal = request.signal
    await new Promise((resolve) => request.signal.addEventListener('abort', resolve, { once: true }))
    yield { type: 'finish', reason: { kind: 'aborted' } }
  }
  const pending = s.runtime.compact(view.discussionId)
  assert.equal(s.runtime.get(view.discussionId).generating, true)
  await assert.rejects(s.runtime.send({ discussionId: view.discussionId, requestId: 'concurrent', text: 'question' }), /正在生成/)
  s.runtime.close(view.discussionId)
  assert.equal(signal.aborted, true)
  assert.equal((await pending).ok, false)
  assert.equal(s.runtime.get(view.discussionId), undefined)
})

await check('a failed partial compaction keeps all previous discussion history', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  await threeTurns(s.runtime, view.discussionId)
  const previousStream = s.llm.stream
  s.llm.stream = async function* () {
    yield { type: 'text-delta', text: 'incomplete summary' }
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'fixture failure' } } }
  }
  assert.equal((await s.runtime.compact(view.discussionId)).ok, false)
  s.llm.stream = previousStream
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'after', text: 'after-failure' })
  assert.ok(hasText(s.requests.at(-1).messages, 'unique-question-0'))
  assert.equal(hasText(s.requests.at(-1).messages, 'incomplete summary'), false)
  s.runtime.closeAll()
})

await check('a second compaction includes the existing summary instead of accumulating summaries', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  await threeTurns(s.runtime, view.discussionId)
  await s.runtime.compact(view.discussionId)
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'four', text: 'fourth-question' })
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'five', text: 'fifth-question' })
  await s.runtime.compact(view.discussionId)
  assert.ok(hasText(s.requests.at(-1).messages, 'reply-4'), 'the previous summary is in the next compaction input')
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'after', text: 'after-compaction' })
  const summaries = s.requests.at(-1).messages.filter((entry) => entry.content.some((item) => item.text?.includes('较早的临时讨论摘要')))
  assert.equal(summaries.length, 1)
  s.runtime.closeAll()
})

await check('later turns preserve earlier discussion answers without resynchronizing the parent', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  s.parent.append('turn/start', { turn: 2 })
  s.parent.append('user/message', message('user', 'later-parent-question'), { surfaceOp: 'append' })
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'one', text: 'first-question' })
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'two', text: 'second-question' })
  assert.ok(hasText(s.requests.at(-1).messages, 'reply-1'))
  assert.equal(hasText(s.requests.at(-1).messages, 'later-parent-question'), false, 'the opening snapshot stays fixed')
  s.runtime.closeAll()
})


await check('real dsh projection retains complete discussion rules for both route modes', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'rules', text: '核查项目进度' })
  const request = s.requests[0]
  for (const mode of [undefined, 'in-history']) {
    const projected = projectToolUpdates(request.messages, request.tools, mode, request.toolHistory)
    const rules = projected.messages.find(entry => entry.role === 'system' && hasText([entry], '你是临时讨论助手'))
    assert.ok(rules, 'the full instruction survives the real provider projection')
    assert.ok(hasText([rules], '本讨论区始终只读'))
    assert.ok(hasText([rules], '找文件使用 glob'))
  }
  const child = s.prepared.get(view.sessionId)
  assert.ok(child.ownEvents().some(event => event.type === 'system/message'))
  assert.equal(s.logs.some(event => event.stage === 'append'), false)
  s.runtime.closeAll()
})

await check('real dsh projection retains both compaction instructions and the resulting summary', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  await threeTurns(s.runtime, view.discussionId)
  await s.runtime.compact(view.discussionId)
  const compact = s.requests.at(-1)
  assert.ok(hasText(projectToolUpdates(compact.messages, compact.tools, 'in-history', undefined).messages, '本讨论区始终只读'))
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'after-real-compact', text: '接着讨论' })
  const request = s.requests.at(-1)
  const projected = projectToolUpdates(request.messages, request.tools, 'in-history', undefined)
  assert.ok(hasText(projected.messages, '较早的临时讨论摘要'))
  assert.ok(hasText(projected.messages, 'reply-4'))
  assert.ok(hasText(projected.messages, '本讨论区始终只读'))
  s.runtime.closeAll()
})


await check('the real DeepSeek serializer sends rules and a paired tool-free finishing request', async () => {
  const s = setup(), view = await s.runtime.open({ parentSessionId: 'parent' })
  s.llm.stream = async function* (request) {
    s.requests.push(request)
    if (s.requests.length === 1) {
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'denied-call', name: 'bash', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield* reply('无法执行命令，相关结果未验证。')
    }
  }
  await s.runtime.send({ discussionId: view.discussionId, requestId: 'serialize-finish', text: '核查项目进度' })
  assert.equal(s.requests.length, 2)
  const captured = [], previousFetch = globalThis.fetch
  const adapter = new DeepSeekAdapter({
    options: () => ({
      baseURL: 'http://127.0.0.1:1', defaults: { thinking: 'disabled' }, maxTokens: 1024,
      models: [{ id: 'fake', systemPromptUpdate: 'in-history' }],
      streamIdleTimeoutMs: 1000, filePolicy: {}, filesApiTimeoutMs: 1000,
      maxRequestFilesBytes: 1024 * 1024, maxInlineRequestImageBytes: 1024 * 1024, maxImagesPerRequest: 10,
    }),
    resolveAuth: async () => ({ headers: {} }),
    resolveUserId: () => 'offline-test',
    prepareExtensions: async () => ({ fields: {}, accept: async () => {} }),
  })
  try {
    // Capture the actual JSON body; no socket is opened and no credential is read.
    globalThis.fetch = async (_url, options) => {
      captured.push(JSON.parse(options.body))
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'offline capture' } }), { status: 400 })
    }
    for (const request of s.requests) {
      const projected = projectToolUpdates(request.messages, request.tools, 'in-history', undefined)
      await assert.rejects(async () => {
        for await (const _chunk of adapter.stream({ ...request, messages: projected.messages, tools: projected.tools })) {}
      }, /offline capture/)
    }
    assert.equal(captured.length, 2, 'both requests reached the real transport serializer')
    for (const wire of captured) {
      assert.ok(wire.messages.some(entry => entry.role === 'system' && entry.content.some(item => item.text?.includes('本讨论区始终只读'))))
    }
    const final = captured.at(-1)
    assert.equal(final.tools, undefined)
    assert.ok(final.messages.some(entry => entry.content.some(item => item.type === 'tool_result' && item.tool_use_id === 'denied-call')))
    assert.ok(final.messages.some(entry => entry.role === 'system' && entry.content.some(item => item.text?.includes(FINAL_ANSWER_INSTRUCTION))))
    assert.equal(s.logs.some(event => event.stage === 'append'), false)
  } finally {
    globalThis.fetch = previousFetch
    s.runtime.closeAll()
  }
})

process.exitCode = failures ? 1 : 0
