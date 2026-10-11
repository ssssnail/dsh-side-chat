import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { apply as applyPlugin } from '../index.js'
const root = process.env.DSH_HARNESS_DIR ?? '/Users/snail/.local/share/pi-node/node-v22.23.2-darwin-x64/lib/node_modules/@deepseek-ai/dsh'
const require = createRequire(`${root}/package.json`)
const { Context } = require('@deepseek-ai/cordis')
const { apply: applyConnection } = require('@deepseek-ai/dsh-client-connection')
const ctx = new Context()
let record
ctx.provide('credentials', { async modifyRecord(_key, fn) { record = await fn(record) ?? record; return record } })
await applyConnection(ctx, {})
const connection = ctx.get('connection')
assert.ok(connection)
const disposers = []
let route
applyPlugin({
  connection,
  webServer: { register(value) { route = value; return () => {} } },
  effect(fn) { const dispose = fn(); disposers.push(dispose) },
})
function response() {
  let finish
  const done = new Promise(resolve => { finish = resolve })
  return { status: 0, headers: {}, body: '', done,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true },
    end(body = '') { this.body += body; finish() },
  }
}
const host = '127.0.0.1:43129'
const launch = new URL(connection.authenticatedUrl(`http://${host}/`))
const exchanged = response()
assert.equal(connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host } }, exchanged), false)
assert.equal(exchanged.status, 303)
const cookie = exchanged.headers['set-cookie'].split(';')[0]
async function ping(headers) {
  const res = response()
  route.handler({ method: 'GET', url: '/side-chat/ping', headers }, res)
  await res.done
  return res
}
try {
  assert.equal((await ping({ host })).status, 401)
  console.log('  ok   actual dsh connection rejects missing browser cookie')
  assert.equal((await ping({ host, cookie, origin: `http://${host}`, 'sec-fetch-site': 'same-origin' })).status, 200)
  console.log('  ok   actual signed browser cookie permits same-origin plugin request')
  assert.equal((await ping({ host, cookie, origin: 'https://untrusted.example', 'sec-fetch-site': 'cross-site' })).status, 403)
  console.log('  ok   valid cookie cannot bypass the actual Origin fence')
  assert.equal((await ping({ host: 'attacker.example', cookie })).status, 403)
  console.log('  ok   invalid Host cannot bypass the actual host fence')
  assert.equal((await ping({ host, cookie: cookie + 'tampered' })).status, 401)
  console.log('  ok   actual browser authentication rejects a tampered cookie')
} finally {
  for (const dispose of disposers.reverse()) dispose?.()
  await ctx.fiber.dispose()
}
