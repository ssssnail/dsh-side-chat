/**
 * Host half of the temporary-discussion (临时讨论) plugin.
 *
 * Responsibilities:
 *  - own the process-local discussion runtime (memory only);
 *  - expose it to the plugin's own Client half over one plugin-owned HTTP
 *    route family (`/side-chat/*`) on the loopback web server;
 *  - never create a Session, never write a session log, never call a tool.
 *
 * Transport note: an installed bundle's Client half cannot reach a
 * runtime-registered Remote namespace (the application's Remote capability set
 * is fixed at build time), so this plugin carries its own small JSON + SSE
 * surface on the host's existing `webServer` route table instead of inventing a
 * second server.
 */

import { createDiscussionRuntime } from './host/runtime.js'

export const name = '@local/dsh-side-chat'

/** Hard dependencies: without these the feature cannot work at all. */
export const inject = ['llm', 'sessions', 'fs', 'webServer']

const ROUTE_PREFIX = '/side-chat'
const MAX_BODY_BYTES = 1_000_000
const IDLE_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Bumped whenever this Host half changes, and reported by `/ping`. The running
 * process keeps the JavaScript generation it loaded, so this is how a live
 * profile confirms whether an edit took effect without a restart.
 */
const PLUGIN_REVISION = 4

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 */
export function apply(ctx) {
  const logger = typeof ctx.logger === 'function' ? ctx.logger('side-chat') : undefined
  /** Metadata-only logging: operation, ids, timings. Never discussion text. */
  const log = (event) => {
    try {
      logger?.debug?.(JSON.stringify(event))
    } catch {
      /* logging must never break a request */
    }
  }

  const runtime = createDiscussionRuntime(ctx, { tools: true, log })
  const lastSeen = new Map()

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          handle(req, res).catch((error) => {
            log({ stage: 'route', error: String(error?.message ?? error) })
            if (!res.headersSent) sendJson(res, 500, { ok: false, message: '讨论接口内部错误。' })
            else res.end()
          })
        },
      }),
    'side-chat:routes',
  )

  // A page that goes away without closing leaves an unreferenced instance; the
  // sweeper is a backstop for the explicit close, not a substitute for it.
  ctx.effect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const discussion of runtime.list()) {
        const seen = lastSeen.get(discussion.discussionId) ?? discussion.createdAt
        if (discussion.generating) continue
        if (now - seen > IDLE_TIMEOUT_MS) {
          runtime.close(discussion.discussionId)
          lastSeen.delete(discussion.discussionId)
          log({ stage: 'reap', discussionId: discussion.discussionId })
        }
      }
    }, 60_000)
    if (typeof timer.unref === 'function') timer.unref()
    return () => clearInterval(timer)
  }, 'side-chat:idle-sweep')

  ctx.effect(
    () => () => {
      runtime.closeAll()
      lastSeen.clear()
    },
    'side-chat:teardown',
  )

  /* ------------------------------------------------------------- transport */

  async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname

    if (req.method === 'GET' && pathname === `${ROUTE_PREFIX}/ping`) {
      return sendJson(res, 200, { ok: true, service: 'side-chat', revision: PLUGIN_REVISION })
    }
    if (req.method === 'GET' && pathname === `${ROUTE_PREFIX}/by-session`) {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      const discussion = runtime.findBySession(sessionId)
      return sendJson(res, 200, discussion ? { ok: true, discussion } : { ok: false, message: '没有该会话的讨论实例。' })
    }

    if (req.method === 'GET' && pathname === `${ROUTE_PREFIX}/models`) {
      return sendJson(res, 200, { ok: true, ...(await runtime.listModels()) })
    }

    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, message: '方法不允许。' })

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      return sendJson(res, 400, { ok: false, message: `请求体无效：${error?.message ?? error}` })
    }
    if (body.discussionId) lastSeen.set(body.discussionId, Date.now())

    try {
      switch (pathname) {
        case `${ROUTE_PREFIX}/open`: {
          const discussion = await runtime.open({
            parentSessionId: body.parentSessionId,
            tag: body.tag,
          })
          lastSeen.set(discussion.discussionId, Date.now())
          return sendJson(res, 200, { ok: true, discussion })
        }
        case `${ROUTE_PREFIX}/send`: {
          if (!runtime.get(body.discussionId)) {
            return sendJson(res, 200, { ok: false, code: 'discussion-gone', message: '讨论实例已关闭。' })
          }
          const stream = openEventStream(res)
          let closedByClient = false
          res.on('close', () => {
            closedByClient = true
            runtime.cancel(body.discussionId, body.requestId)
          })
          try {
            await runtime.send(
              { discussionId: body.discussionId, requestId: body.requestId, text: body.text },
              (event) => stream.send(event),
            )
          } catch (error) {
            if (!closedByClient) {
              stream.send({ type: 'error', message: String(error?.message ?? error), code: error?.code })
              stream.send({ type: 'done', status: 'error', text: '' })
            }
          }
          stream.end()
          return undefined
        }
        case `${ROUTE_PREFIX}/cancel`:
          return sendJson(res, 200, { ok: true, ...runtime.cancel(body.discussionId, body.requestId) })
        case `${ROUTE_PREFIX}/close`: {
          const result = runtime.close(body.discussionId)
          lastSeen.delete(body.discussionId)
          return sendJson(res, 200, result)
        }
        case `${ROUTE_PREFIX}/compact`:
          return sendJson(res, 200, await runtime.compact(body.discussionId))
        case `${ROUTE_PREFIX}/model`:
          return sendJson(res, 200, await runtime.setModel(body.discussionId, body.route ?? body))
        default:
          return sendJson(res, 404, { ok: false, message: `未知的讨论接口：${pathname}` })
      }
    } catch (error) {
      log({ stage: 'dispatch', pathname, error: String(error?.message ?? error) })
      if (res.headersSent) {
        res.end()
        return undefined
      }
      return sendJson(res, 200, {
        ok: false,
        code: error?.code ?? 'side-chat-error',
        message: String(error?.message ?? error),
      })
    }
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (chunks.length === 0) return resolve({})
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) {
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** Open one server-sent-event stream; every frame carries an in-request ordinal. */
function openEventStream(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.write(': side-chat stream open\n\n')
  let ordinal = 0
  let closed = false
  res.on('close', () => {
    closed = true
  })
  return {
    send(event) {
      if (closed) return
      try {
        res.write(`data: ${JSON.stringify({ ...event, seq: ordinal++ })}\n\n`)
      } catch {
        closed = true
      }
    },
    end() {
      if (closed) return
      closed = true
      try {
        res.write('data: [DONE]\n\n')
      } catch {
        /* the client is already gone */
      }
      res.end()
    },
  }
}
