/**
 * Live end-to-end test of the running plugin, driven from this machine.
 *
 * The discussion API is a plain loopback route, so this drives the real thing —
 * a real model call, the real read-only toolbox, the real Session — against the
 * running host rather than a fake.
 *
 *   node test/live.mjs                 # ping + open + one question + close
 *   SIDE_CHAT_TOOL=1 node test/live.mjs # ask something that needs a file read
 *
 * It is deliberately NOT part of `npm test`: it costs a model call and needs a
 * running profile.
 */

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const PARENT = process.env.DSH_SESSION_ID

const headers = { 'content-type': 'application/json' }

async function api(path, body) {
  const response = await fetch(`${BASE}/side-chat${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  try {
    return { status: response.status, json: JSON.parse(text) }
  } catch {
    return { status: response.status, text }
  }
}

/** Read one SSE turn and return its frames. */
async function stream(body) {
  const response = await fetch(`${BASE}/side-chat/send`, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const frames = []
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const line = frame.split('\n').find((row) => row.startsWith('data: '))
      if (!line) continue
      const payload = line.slice(6)
      if (payload === '[DONE]') return frames
      try {
        frames.push(JSON.parse(payload))
      } catch {
        /* ignore a partial frame */
      }
    }
  }
  return frames
}

console.log('\nside-chat live test\n')

const ping = await api('/ping')
console.log('ping     ', JSON.stringify(ping.json))
if (ping.json?.revision === undefined) {
  console.log('  NOTE: no `revision` in the ping response — the running Host half is the')
  console.log('        JavaScript generation loaded at startup, so host-side changes are')
  console.log('        NOT live yet. Restart the profile to load them.')
}

if (!PARENT) {
  console.log('\nDSH_SESSION_ID is not set, so there is no main session to bind to.')
  process.exit(0)
}

const opened = await api('/open', { parentSessionId: PARENT, tag: 'live-test' })
console.log('open     ', JSON.stringify({ ...opened.json, discussion: opened.json?.discussion && {
  discussionId: opened.json.discussion.discussionId,
  sessionId: opened.json.discussion.sessionId,
  completedTurns: opened.json.discussion.completedTurns,
  excludedInflight: opened.json.discussion.excludedInflight,
  truncated: opened.json.discussion.truncated,
  estimatedTokens: opened.json.discussion.estimatedTokens,
  tools: opened.json.discussion.tools,
  route: opened.json.discussion.route,
} }, null, 0))
if (!opened.json?.ok) process.exit(1)
const discussionId = opened.json.discussion.discussionId

const question = process.env.SIDE_CHAT_TOOL === '1'
  ? '请用 read 工具读一下这个工作区里的 package.json，然后用一句话说它的 name 字段。'
  : '用一句话回答：这个讨论区是只读的吗？'
console.log(`\n> ${question}`)
const frames = await stream({ discussionId, requestId: `live-${Date.now()}`, text: question })

let text = ''
let tools = 0
let notices = []
for (const frame of frames) {
  if (frame.type === 'text') text += frame.text
  else if (frame.type === 'tool') {
    if (frame.status !== 'running') {
      tools += 1
      console.log(`  tool  ${frame.name}: ${frame.status}${frame.text ? ` — ${frame.text.slice(0, 160)}` : ''}`)
    }
  } else if (frame.type === 'notice') notices.push(frame.message)
  else if (frame.type === 'error') console.log(`  error ${frame.message}`)
}
const done = frames.at(-1)
console.log(`\nanswer   ${text.trim() || '(none)'}`)
console.log(`status   ${done?.status} · tools ${tools} · stats ${JSON.stringify(done?.stats ?? {})}`)
for (const notice of notices) console.log(`notice   ${notice}`)

const closed = await api('/close', { discussionId })
console.log('close    ', JSON.stringify(closed.json))
console.log('')
