/**
 * Dry run for the side-chat Host half.
 *
 * Builds a fake Cordis context (sessions, llm, fs, tokenMeter, webServer) and
 * drives the real plugin code through the real HTTP handler: open → send
 * (streaming, with a read-only tool call) → cancel → close, plus the read-only
 * path-containment refusal. Nothing is installed and no model is called.
 */

import assert from 'node:assert/strict'
import { apply } from '../index.js'

/* ------------------------------------------------------------------ fake session */

const TURNS = [
  { user: '请把 build 配置迁移到 vite。', assistant: '好的，我先读一下配置文件。' },
]

/**
 * The fixture's stand-in for a Session message projection: the same function
 * feeds the parent's `deriveEventMessage` and a discussion Session's
 * `deriveMessages`, so the seeded prefix derives exactly like the real one.
 */
function projectFixtureEvent(event) {
  // `tool/call` is a log-only event: the call itself lives in the assistant
  // message that carries the tool-call block, exactly as the real projection has it.
  if (event.type === 'tool/call') return null
  if (event.type === 'tool/result') {
    // The real event carries a complete ToolResultMessage; the fixture's own
    // seed events use a shorthand.
    if (event.data.message) return event.data.message
    return {
      id: `t${event.seq}`,
      role: 'tool',
      source: { kind: 'tool', callId: event.data.callId },
      toolCallId: event.data.callId,
      content: [{ type: 'text', text: event.data.text ?? '' }],
    }
  }
  if (event.type === 'user/message') {
    return { id: `u${event.seq}`, role: 'user', content: [{ type: 'text', text: event.data.text }], source: { kind: 'user' } }
  }
  if (event.type === 'assistant/message') {
    if (event.data.message) return event.data.message
    return {
      id: `a${event.seq}`,
      role: 'assistant',
      content: event.data.content ?? [{ type: 'text', text: event.data.text }],
      source: { kind: 'model', provider: 'fake', model: 'fake-1' },
    }
  }
  if (event.type === 'developer/message') return event.data.message
  return null
}

function buildSession(cwd = '/ws') {
  const events = []
  const nodes = []
  let seq = 0
  const push = (type, data) => {
    seq += 1
    events.push({ type, seq, time: 1_700_000_000_000 + seq, data })
    nodes.push(seq)
    return events[events.length - 1]
  }
  /** A log-only event: recorded in the session, never a model-visible surface node. */
  const pushMeta = (type, data) => {
    seq += 1
    events.push({ type, seq, time: 1_700_000_000_000 + seq, data })
    return events[events.length - 1]
  }
  for (const turn of TURNS) {
    push('turn/start', { turn: 1 })
    push('user/message', { text: turn.user })
    push('tool/call', { callId: 'call-a', name: 'read', arguments: '{"file_path":"README.md"}' })
    push('assistant/message', {
      content: [{ type: 'tool-call', id: 'call-a', name: 'read', arguments: '{"file_path":"README.md"}' }],
    })
    push('tool/result', {
      message: {
        id: 't-call-a',
        role: 'tool',
        source: { kind: 'tool', callId: 'call-a' },
        toolCallId: 'call-a',
        content: [{ type: 'text', text: '# side-chat' }],
      },
    })
    push('assistant/message', { text: turn.assistant })
    push('turn/end', { turn: 1, reason: { kind: 'completed' } })
  }
  // One in-flight turn that must be ignored by the snapshot.
  push('turn/start', { turn: 2 })
  push('user/message', { text: '这条未完成的问题不应进入快照' })
  // The composer's latest model choice, which must win over the last request
  // header (`fake`/`fake-1`) exactly as it does for the main session.
  pushMeta('model/selection', { provider: 'fake-2', model: 'fake-2-model', reasoningEffort: 'high' })

  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return {
    header: { cwd },
    snapshotEvents: (from, to) => events.slice(from, to),
    ownEvents: () => events,
    surface: { nodes },
    eventAt: (value) => bySeq.get(value),
    deriveEventMessage: (event) => projectFixtureEvent(event),
    requestHeader: () => ({ config: { provider: 'fake', model: 'fake-1' } }),
  }
}

/* ------------------------------------------------------------------ fake fs */

const FILES = new Map([
  ['/ws/README.md', '# side-chat\nsecond line\n'],
  ['/ws/src/app.js', 'export const answer = 42\n'],
  ['/outside/secret.txt', 'top secret\n'],
])

const fs = {
  async resolve(path, opts) {
    const base = opts?.cwd ?? '/'
    const normalized = normalize(path.startsWith('/') ? path : `${base}/${path}`)
    return { targetKey: normalized, displayPath: normalized }
  },
  processPath: (target) => target.displayPath,
  fileUrl: (target) => `file://${target.displayPath}`,
  contains(parent, child) {
    if (parent.targetKey === child.targetKey) return true
    return child.targetKey.startsWith(`${parent.targetKey}/`)
  },
  async stat(target) {
    if (FILES.has(target.targetKey)) return { version: 'v', type: 'file', size: FILES.get(target.targetKey).length }
    if (isDirectory(target.targetKey)) return { version: 'v', type: 'directory' }
    return undefined
  },
  async lstat(path) {
    return { version: 'v', type: FILES.has(normalize(path)) ? 'file' : 'directory' }
  },
  async readText(target) {
    const text = FILES.get(target.targetKey)
    if (text === undefined) throw new Error(`ENOENT ${target.displayPath}`)
    return text
  },
  async listDir(target) {
    const prefix = `${target.targetKey}/`
    const names = new Map()
    for (const key of FILES.keys()) {
      if (!key.startsWith(prefix)) continue
      const rest = key.slice(prefix.length)
      const head = rest.split('/')[0]
      if (rest.includes('/')) names.set(head, { name: head, type: 'directory', target: { targetKey: prefix + head, displayPath: prefix + head } })
      else names.set(head, { name: head, type: 'file', target: { targetKey: key, displayPath: key }, size: FILES.get(key).length })
    }
    return [...names.values()]
  },
}

function normalize(path) {
  // The pretend symlink: /ws/link/** resolves outside the workspace.
  if (path.includes('link')) return '/outside/secret.txt'
  const parts = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

function isDirectory(key) {
  if (key === '/ws' || key === '/outside') return true
  for (const file of FILES.keys()) if (file.startsWith(`${key}/`)) return true
  return false
}

/* ------------------------------------------------------------------ fake llm */

function fakeLlm() {
  const requests = []
  const script = []
  const llm = {
    requests,
    queue(handler) {
      script.push(handler)
    },
    listProviders: () => [{ id: 'fake', name: 'Fake' }],
    listModels: async () => [{ id: 'fake-1', name: 'Fake One' }],
    resolveModelInfo: async () => ({ context: { contextWindow: 128000 }, defaultMaxTokens: 8192 }),
    stream(options) {
      requests.push(options)
      const handler = script.shift()
      if (!handler) throw new Error('no scripted response')
      return handler(options)
    },
  }
  return llm
}

async function* textStream(chunks, usage, finish = { kind: 'stop' }) {
  for (const [index, text] of chunks.entries()) {
    yield { type: 'block-start', index, blockType: 'text' }
    yield { type: 'text-delta', index, text }
    yield { type: 'block-end', index, block: { type: 'text', text } }
  }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: finish }
}

async function* toolCallStream() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '我先读一下文件。' }
  yield { type: 'block-end', index: 0, block: { type: 'text', text: '我先读一下文件。' } }
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"file_path":"README.md"}' } }
  yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 3 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* missingFileStream() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-m', name: 'read', arguments: '{"file_path":"nowhere.txt"}' } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* escapeStream() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-2', name: 'read', arguments: '{"file_path":"/ws/link/secret.txt"}' } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* bashStream() {
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-3', name: 'bash', arguments: '{"command":"rm -rf /"}' } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

async function* hangingStream(signal) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '正在' }
  for (;;) {
    if (signal?.aborted) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted', code: 'aborted' } } }
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/* ------------------------------------------------- adapter pairing contract */

/**
 * Mirror of `dsh-llm-deepseek`'s serialize() acceptance rules: a developer
 * message is only legal once a user/tool-result turn precedes it, a tool result
 * maps to a user turn, every tool result must answer the pending calls, and the
 * history may not end with an unresolved call. This is what a real provider
 * request is validated against before it is sent.
 */
function assertProviderAcceptable(history, label) {
  const wire = []
  let buffered = []
  const flush = () => {
    if (buffered.length === 0) return
    if (wire.at(-1)?.role !== 'user') throw new Error(`${label}: system update without a preceding user or tool-result turn`)
    wire.push(...buffered)
    buffered = []
  }
  for (const message of history) {
    if (message.role === 'developer') {
      buffered.push({ role: 'system', content: message.content })
      continue
    }
    if (message.role === 'system') continue
    if (message.role === 'assistant') flush()
    const role = message.role === 'tool' ? 'user' : message.role
    const content =
      message.role === 'assistant'
        ? message.content.map((block) =>
            block.type === 'tool-call'
              ? { type: 'tool_use', id: block.id, name: block.name, input: JSON.parse(block.arguments || '{}') }
              : block,
          )
        : message.role === 'tool'
          ? [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]
          : message.content.filter((block) => block.type === 'text')
    if (message.role === 'user' && content.length === 0) continue
    const previous = wire.at(-1)
    if (previous?.role === role) previous.content.push(...content)
    else wire.push({ role, content })
  }
  flush()
  let pending = new Set()
  for (const message of wire) {
    if (message.role === 'assistant') {
      const calls = message.content.filter((block) => block.type === 'tool_use')
      pending = new Set(calls.map((block) => block.id))
      if (pending.size !== calls.length) throw new Error(`${label}: duplicate tool call id`)
    } else if (message.role === 'user') {
      const results = message.content.filter((block) => block.type === 'tool_result')
      for (const result of results) {
        if (!pending.delete(result.tool_use_id)) throw new Error(`${label}: tool result has no matching call`)
      }
      if (pending.size > 0) throw new Error(`${label}: tool calls need immediate results`)
    }
  }
  if (pending.size > 0) throw new Error(`${label}: history ends with unresolved tools`)
  return wire
}

/* ------------------------------------------------------- fake session store */

/** Sessions the plugin creates for a discussion, with everything appended. */
const discussionSessions = new Map()
/** The Session a discussion instance created, for assertions. */
function createdSessionFor(discussionId) {
  for (const created of discussionSessions.values()) if (created.discussionId === discussionId) return created
  return undefined
}
/** Live attempt frames the plugin publishes. */
const liveFrames = []

function makeDiscussionSession(id, seed) {
  const events = [...(seed ?? [])]
  const appended = []
  return {
    id,
    header: { id },
    appended,
    append(type, data, intent) {
      const event = { type, seq: events.length, time: Date.now(), data, ...(intent ?? {}) }
      events.push(event)
      appended.push(event)
      return event
    },
    deriveMessages: () => events.map(projectFixtureEvent).filter(Boolean),
    snapshotEvents: (from, to) => events.slice(from, to),
  }
}

/* ------------------------------------------------------------------ fake ctx */

const session = buildSession()
const llm = fakeLlm()
/** Multiplier on the fake meter, so a budget cut can be forced on a small fixture. */
let tokenScale = 1
const routes = []
let indexTap = null
let effects = 0

const ctx = {
  logger: () => ({ debug: () => {} }),
  // Cordis exposes injected services as context properties; `inject` guarantees
  // these exist in a real profile.
  llm,
  fs,
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
    tapIndex(transform) {
      indexTap = transform
      return () => {}
    },
  },
  sessions: {
    get: (id) => (id === 'session-1' ? session : discussionSessions.get(id)),
    prepare: (id, options) => {
      const created = makeDiscussionSession(id, options?.seed ?? [])
      created.prepared = true
      return created
    },
    enter: (prepared) => {
      discussionSessions.set(prepared.id, prepared)
      return () => discussionSessions.delete(prepared.id)
    },
    announce: () => {},
  },
  emit: (name, payload) => {
    if (name === 'agent/assistant-stream' && payload?.frame) liveFrames.push(payload.frame)
  },
  get(name) {
    if (name === 'sessions') return ctx.sessions
    if (name === 'llm') return llm
    if (name === 'fs') return fs
    if (name === 'tokenMeter') return { estimateMessage: (message) => JSON.stringify(message).length * tokenScale }
    if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake', model: 'fake-1' }) }
    return undefined
  },
  effect(callback) {
    effects += 1
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
}

apply(ctx)
assert.equal(routes.length, 1, 'one route registered')
assert.equal(routes[0].path, '/side-chat')

const handler = routes[0].handler

/* ------------------------------------------------------------------ http mocks */

function mockRequest(method, path, body) {
  const listeners = new Map()
  const req = {
    method,
    url: path,
    headers: { 'content-type': 'application/json' },
    on(event, listener) {
      listeners.set(event, listener)
      return req
    },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined) listeners.get('data')?.(Buffer.from(JSON.stringify(body)))
    listeners.get('end')?.()
  })
  return req
}

function mockResponse() {
  let settle
  const finished = new Promise((resolve) => {
    settle = resolve
  })
  const res = {
    status: 0,
    headers: null,
    headersSent: false,
    body: '',
    finished,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
      res.headersSent = true
      return res
    },
    write(chunk) {
      res.body += chunk
      return true
    },
    end(chunk) {
      if (chunk) res.body += chunk
      res.headersSent = true
      settle()
      return res
    },
    on() {
      return res
    },
  }
  return res
}

function parseFrames(body) {
  return body
    .split('\n\n')
    .map((block) => block.split('\n').find((row) => row.startsWith('data: ')))
    .filter(Boolean)
    .map((line) => line.slice(6))
    .filter((payload) => payload !== '[DONE]')
    .map((payload) => JSON.parse(payload))
}

/** Start a request without waiting; the caller awaits `res.finished`. */
function startCall(method, path, body) {
  const res = mockResponse()
  handler(mockRequest(method, path, body), res)
  return res
}

async function call(method, path, body) {
  const res = startCall(method, path, body)
  await res.finished
  let json
  try {
    json = JSON.parse(res.body)
  } catch {
    json = undefined
  }
  return { status: res.status, json, frames: parseFrames(res.body), headers: res.headers }
}

/* ------------------------------------------------------------------ the run */

const failures = []
async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures.push(label)
    console.log(`  FAIL ${label}\n       ${error.message}`)
  }
}

console.log('\nside-chat dry run\n')

await check('opens a discussion and captures only completed turns', async () => {
  const result = await call('POST', '/side-chat/open', { parentSessionId: 'session-1', tag: 't1' })
  assert.equal(result.status, 200)
  assert.equal(result.json.ok, true)
  const discussion = result.json.discussion
  assert.equal(discussion.completedTurns, 1)
  assert.equal(discussion.excludedInflight, true)
  assert.equal(discussion.truncated, false)
  assert.deepEqual(discussion.tools, ['read', 'glob', 'grep'])
  // Consistent with the main session: the last `model/selection` wins over the
  // last logged request header.
  assert.equal(discussion.route.provider, 'fake-2')
  assert.equal(discussion.route.model, 'fake-2-model')
  assert.equal(discussion.route.reasoningEffort, 'high')
  globalThis.discussionId = discussion.discussionId
  globalThis.discussionSessionId = discussion.sessionId
})

await check('refuses an unknown parent session', async () => {
  const result = await call('POST', '/side-chat/open', { parentSessionId: 'nope' })
  assert.equal(result.json.ok, false)
  assert.equal(result.json.code, 'session-not-live')
})

await check('streams a read-only tool round and a final answer', async () => {
  llm.queue(() => toolCallStream())
  llm.queue(() => textStream(['README 里只有两行，', '不需要改动。'], { inputTokens: 42, outputTokens: 9, cacheReadTokens: 7, cacheWriteTokens: 2 }))
  const result = await call('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-1',
    text: '这个仓库的说明文件写了什么？',
  })
  const types = result.frames.map((frame) => frame.type)
  assert.ok(types.includes('tool'), 'tool event streamed')
  assert.ok(types.includes('text'), 'text streamed')
  const done = result.frames.at(-1)
  assert.equal(done.type, 'done')
  assert.equal(done.status, 'done')
  assert.match(done.text, /不需要改动/)
  assert.equal(done.stats.toolCalls, 1)
  assert.equal(done.stats.cacheReported, true)
  assert.equal(done.stats.cacheReadTokens, 7)
  assert.equal(done.stats.inputTokens, 42)
  assert.ok(typeof done.stats.ttfbMs === 'number')
  // Every frame is instance- and request-scoped.
  for (const frame of result.frames) {
    assert.equal(frame.discussionId, globalThis.discussionId)
    assert.equal(frame.requestId, 'req-1')
    assert.ok(typeof frame.seq === 'number')
  }
  // The second request inherited the first round's tool result and the instruction.
  const followUp = llm.requests.at(-1)
  assert.ok(followUp.messages.some((message) => message.role === 'tool'), 'tool result kept in history')
  assert.ok(followUp.messages.some((message) => message.role === 'developer'), 'discussion instruction present')
  assert.equal(followUp.messages.some((message) => message.type === 'text' && /未完成的问题/.test(message.text ?? '')), false)
  assert.equal(followUp.sessionId, undefined, 'never binds a session id')
})

await check('rejects a path outside the workspace and closes the turn', async () => {
  llm.queue(() => escapeStream())
  const before = llm.requests.length
  const result = await call('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-2',
    text: '读一下工作区外面的文件',
  })
  const toolFrames = result.frames.filter((frame) => frame.type === 'tool')
  assert.equal(toolFrames.at(-1).status, 'error')
  // Factual, professional, and it names the accessible range.
  assert.match(toolFrames.at(-1).text, /不在本次会话可访问的工作区内/)
  assert.match(toolFrames.at(-1).text, /可访问范围：/)
  assert.ok(
    result.frames.some((frame) => frame.type === 'notice' && /按只读范围拒绝/.test(frame.message ?? '')),
    'the turn closed instead of inviting another attempt',
  )
  assert.equal(llm.requests.length, before + 1, 'no second provider request was made')
  const refusal = discussionSessions.get(globalThis.discussionSessionId)
  const refusalResult = refusal.appended.filter((event) => event.type === 'tool/result').at(-1)
  assert.equal(refusalResult.data.message.isError, true, 'the refusal is a durable tool result')
})

await check('refuses a tool that is not whitelisted, once', async () => {
  llm.queue(() => bashStream())
  const before = llm.requests.length
  const result = await call('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-3',
    text: '帮我删掉这个目录',
  })
  const toolFrames = result.frames.filter((frame) => frame.type === 'tool')
  assert.equal(toolFrames.at(-1).name, 'bash')
  assert.equal(toolFrames.at(-1).status, 'error')
  assert.match(toolFrames.at(-1).text, /该工具在临时会话中不可用/)
  assert.ok(result.frames.some((frame) => frame.type === 'notice'), 'closed with a notice')
  assert.equal(llm.requests.length, before + 1, 'the model was not asked again')
})

await check('stops a running answer and keeps the partial text', async () => {
  llm.queue((options) => hangingStream(options.signal))
  const pending = startCall('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-4',
    text: '一个很长的讨论问题',
  })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const cancel = await call('POST', '/side-chat/cancel', {
    discussionId: globalThis.discussionId,
    requestId: 'req-4',
  })
  assert.equal(cancel.json.cancelled, true)
  await pending.finished
  const done = parseFrames(pending.body).at(-1)
  assert.equal(done.type, 'done')
  assert.equal(done.status, 'stopped')
  assert.match(done.text, /正在/)
})

await check('rejects a second concurrent send in one instance', async () => {
  llm.queue((options) => hangingStream(options.signal))
  const first = startCall('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-5',
    text: '第一个问题',
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  const second = await call('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-6',
    text: '第二个问题',
  })
  assert.ok(
    second.frames.some((frame) => /正在生成回答/.test(frame.message ?? '')),
    `expected a busy refusal, got ${JSON.stringify(second.frames)}`,
  )
  await call('POST', '/side-chat/cancel', { discussionId: globalThis.discussionId, requestId: 'req-5' })
  await first.finished
})

await check('idempotently closes, then refuses further sends', async () => {
  const first = await call('POST', '/side-chat/close', { discussionId: globalThis.discussionId })
  assert.equal(first.json.ok, true)
  const second = await call('POST', '/side-chat/close', { discussionId: globalThis.discussionId })
  assert.equal(second.json.ok, true)
  assert.equal(second.json.alreadyClosed, true)
  const send = await call('POST', '/side-chat/send', {
    discussionId: globalThis.discussionId,
    requestId: 'req-7',
    text: '还在吗',
  })
  assert.equal(send.json.code, 'discussion-gone')
})

await check('lists providers and models for the discussion model menu', async () => {
  const result = await call('GET', '/side-chat/models')
  assert.deepEqual(result.json.providers, [{ id: 'fake', name: 'Fake' }])
  assert.deepEqual(result.json.models.fake, [{ id: 'fake-1', name: 'Fake One' }])
})

await check('drives a real Session with real events and live frames', async () => {
  const open = await call('POST', '/side-chat/open', { parentSessionId: 'session-1' })
  const discussion = open.json.discussion
  assert.ok(discussion.sessionId, 'the discussion reports its Session id')
  const created = discussionSessions.get(discussion.sessionId)
  assert.ok(created, 'the Session was entered into the store')
  assert.ok(created.appended.length === 0, 'nothing is appended before the first question')

  llm.queue(() => toolCallStream())
  llm.queue(() => textStream(['不需要改动。'], { inputTokens: 30, outputTokens: 5, cacheReadTokens: 20 }))
  await call('POST', '/side-chat/send', {
    discussionId: discussion.discussionId,
    requestId: 'req-events',
    text: '说明文件写了什么？',
  })

  const types = created.appended.map((event) => event.type)
  assert.deepEqual(types.slice(0, 3), ['turn/start', 'developer/message', 'user/message'])
  // The fixture's parent ends in turn 2 (its in-flight turn), so discussion
  // turns continue from there instead of colliding.
  assert.equal(created.appended[0].data.turn, 2)
  for (const expected of ['step/start', 'step/end', 'request/header', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']) {
    assert.ok(types.includes(expected), `appended ${expected}`)
  }
  assert.equal(types.filter((type) => type === 'assistant/message').length, 2, 'one assistant message per step')
  const assistant = created.appended.find((event) => event.type === 'assistant/message')
  assert.equal(assistant.surfaceOp, 'append')
  assert.ok(Array.isArray(assistant.data.stream) && assistant.data.stream.length > 0, 'durable stream records')
  const withUsage = created.appended
    .filter((event) => event.type === 'assistant/message')
    .map((event) => event.data.usage)
    .filter(Boolean)
  assert.ok(
    withUsage.some((usage) => usage.inputTokens === 30 && usage.cacheReadTokens === 20),
    'usage is recorded on the durable message',
  )
  const user = created.appended.find((event) => event.type === 'user/message')
  assert.equal(user.data.content[0].text, '说明文件写了什么？')
  assert.equal(created.appended.at(-1).data.reason.kind, 'completed')
  // Every opened step is closed exactly once, before the turn ends.
  const order = created.appended.map((event) => event.type)
  assert.equal(order.filter((type) => type === 'step/start').length, order.filter((type) => type === 'step/end').length)

  const mine = liveFrames.filter((frame) => String(frame.attemptId).startsWith(discussion.sessionId))
  assert.ok(mine.some((frame) => frame.type === 'start'), 'a live attempt started')
  assert.ok(mine.some((frame) => frame.type === 'chunk'), 'chunks were published live')
  const end = mine.find((frame) => frame.type === 'end')
  assert.equal(end.outcome.kind, 'committed')
  assert.equal(end.outcome.eventType, 'assistant/message')
  assert.ok(end.attemptId.startsWith(discussion.sessionId), 'the frame names its session')

  // Closing destroys the Session as well as the instance.
  await call('POST', '/side-chat/close', { discussionId: discussion.discussionId })
  assert.equal(discussionSessions.has(discussion.sessionId), false, 'the Session was detached')
})

await check('builds a request the provider accepts, tool pairs intact', async () => {
  const open = await call('POST', '/side-chat/open', { parentSessionId: 'session-1' })
  const discussionId = open.json.discussion.discussionId
  llm.queue(() => textStream(['快照里有一次 read 调用。'], { inputTokens: 20, outputTokens: 6 }))
  await call('POST', '/side-chat/send', { discussionId, requestId: 'req-pair', text: '快照里有哪些工具调用？' })
  const request = llm.requests.at(-1)
  const wire = assertProviderAcceptable(request.messages, 'turn 1')
  assert.ok(
    wire.some((message) => message.content.some((block) => block.type === 'tool_use')),
    'inherited tool call kept',
  )
  assert.ok(wire.some((message) => message.role === 'system'), 'instruction became a system update')
  await call('POST', '/side-chat/close', { discussionId })
})

await check('keeps the inherited tool pair intact after a budget cut', async () => {
  const previous = llm.resolveModelInfo
  tokenScale = 400
  llm.resolveModelInfo = async () => ({ context: { contextWindow: 8000 }, defaultMaxTokens: 100 })
  try {
    const open = await call('POST', '/side-chat/open', { parentSessionId: 'session-1' })
    const discussion = open.json.discussion
    assert.equal(discussion.truncated, true, 'the snapshot was trimmed to the budget')
    llm.queue(() => textStream(['裁剪后仍然成对。'], { inputTokens: 12, outputTokens: 4 }))
    await call('POST', '/side-chat/send', { discussionId: discussion.discussionId, requestId: 'req-trim', text: '再看一次' })
    const wire = assertProviderAcceptable(llm.requests.at(-1).messages, 'trimmed turn')
    const results = wire.flatMap((message) => message.content.filter((block) => block.type === 'tool_result'))
    for (const result of results) {
      assert.ok(
        wire.some((message) => message.content.some((block) => block.type === 'tool_use' && block.id === result.tool_use_id)),
        'no tool result is left without its call',
      )
    }
    await call('POST', '/side-chat/close', { discussionId: discussion.discussionId })
  } finally {
    llm.resolveModelInfo = previous
    tokenScale = 1
  }
})

await check('closes tool calls left open by a capped turn, so the next request works', async () => {
  // The provider rejects a request whose history ends with an unanswered tool
  // call ("tool calls need immediate results"). A turn can be cut short with
  // calls still open, so the assembled request must close them.
  const open = await call('POST', '/side-chat/open', { parentSessionId: 'session-1' })
  const discussionId = open.json.discussion.discussionId
  for (let round = 0; round < 5; round += 1) llm.queue(() => toolCallStream())
  const capped = await call('POST', '/side-chat/send', {
    discussionId,
    requestId: 'req-cap',
    text: '反复读取同一个文件',
  })
  assert.ok(
    capped.frames.some((frame) => frame.type === 'notice'),
    'the round cap was reported',
  )
  const lastAssistant = capped.frames.filter((frame) => frame.type === 'tool').length
  assert.ok(lastAssistant >= 4, 'the tool rounds ran')

  llm.queue(() => textStream(['第二阶段正常。'], { inputTokens: 9, outputTokens: 3 }))
  const second = await call('POST', '/side-chat/send', {
    discussionId,
    requestId: 'req-after-cap',
    text: '继续',
  })
  const request = llm.requests.at(-1)
  assertProviderAcceptable(request.messages, 'after a capped turn')
  const synthetic = request.messages.filter(
    (message) => message.role === 'tool' && /未完成/.test(message.content?.[0]?.text ?? ''),
  )
  assert.ok(synthetic.length >= 1, 'the open call was closed with a synthetic result')
  assert.match(second.frames.at(-1).text, /第二阶段正常/)
  await call('POST', '/side-chat/close', { discussionId })
})

await check('refuses an identical repeat of a failed tool call and ends the turn', async () => {
  const open = await call('POST', '/side-chat/open', { parentSessionId: 'session-1' })
  const discussionId = open.json.discussion.discussionId
  llm.queue(() => missingFileStream())
  llm.queue(() => missingFileStream())
  const result = await call('POST', '/side-chat/send', {
    discussionId,
    requestId: 'req-dup',
    text: '再读一次不存在的文件',
  })
  const errors = result.frames.filter((frame) => frame.type === 'tool' && frame.status === 'error')
  assert.equal(errors.length, 2, 'two failed tool rounds were streamed')
  assert.match(errors[0].text, /文件不存在/)
  assert.match(errors[1].text, /不再重复执行/, 'the identical retry never reached the tool')
  assert.ok(
    result.frames.some((frame) => frame.type === 'notice' && /重复执行|按只读范围拒绝/.test(frame.message ?? '')),
    'the runaway turn ended with a notice',
  )
  await call('POST', '/side-chat/close', { discussionId })
})

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}\n`)
process.exit(failures.length === 0 ? 0 : 1)
