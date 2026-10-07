/**
 * Context snapshot capture.
 *
 * The snapshot is the reference material a discussion instance inherits once,
 * at open time. It is derived the same way a model request derives its own
 * history: walk the parent Session's *surface* nodes (model-visible order) and
 * ask the Session to project each event into a message. Nothing is rewritten,
 * summarised, or re-serialised, so the inherited prefix keeps the shapes the
 * provider already cached.
 *
 * The capture stops at the last *completed* turn: an in-flight turn is ignored
 * rather than awaited, so opening a discussion never blocks or perturbs the
 * main task. When no turn has completed, the reference is empty.
 */

/** Extra head-room kept for the answer plus discussion history, in tokens. */
const DISCUSSION_RESERVE_TOKENS = 3000
/** Fallback answer reservation when the adapter does not report one. */
const FALLBACK_ANSWER_TOKENS = 8192
/** Upper bound on a single snapshot, so a huge session cannot stall the open. */
const MAX_SNAPSHOT_MESSAGES = 4000

/**
 * Capture one immutable-in-practice snapshot of a live parent Session.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context.
 * @param {string} parentSessionId - the bound main session.
 * @param {(event: object) => void} [log] - metadata-only logger.
 * @returns {Promise<object>} snapshot result, or `{ ok: false }` with a reason.
 */
export async function captureSnapshot(ctx, parentSessionId, log = () => {}) {
  const sessions = ctx.get('sessions')
  if (!sessions) return { ok: false, code: 'sessions-unavailable', message: '会话服务不可用。' }
  const session = sessions.get(parentSessionId)
  if (!session) {
    return {
      ok: false,
      code: 'session-not-live',
      message: '主会话当前不在内存中，无法取得讨论快照。请先在界面中打开该会话。',
    }
  }

  const events = session.ownEvents()
  let boundarySeq = -1
  let boundaryTime = 0
  let completedTurns = 0
  for (const event of events) {
    if (event.type !== 'turn/end') continue
    boundarySeq = event.seq
    boundaryTime = event.time
    completedTurns += 1
  }

  const entries = []
  const nodes = session.surface?.nodes ?? []
  let excludedInflight = false
  for (const seq of nodes) {
    if (entries.length >= MAX_SNAPSHOT_MESSAGES) break
    if (boundarySeq >= 0 && seq > boundarySeq) {
      excludedInflight = true
      continue
    }
    const event = session.eventAt(seq)
    if (!event) continue
    let message = null
    try {
      message = session.deriveEventMessage(event)
    } catch (error) {
      log({ stage: 'derive', type: event.type, error: String(error?.message ?? error) })
      message = null
    }
    if (message) entries.push({ seq, message })
  }
  if (boundarySeq < 0 && nodes.length > 0) excludedInflight = true

  const selected = selectRoute(ctx, session)
  const contextWindow = await resolveContextWindow(ctx, selected, log)
  const trimmed = trimToBudget(ctx, entries, contextWindow, log)
  const messages = trimmed.entries.map((entry) => entry.message)

  return {
    ok: true,
    parentSessionId,
    cwd: typeof session.header?.cwd === 'string' ? session.header.cwd : undefined,
    capturedAt: Date.now(),
    boundarySeq: boundarySeq >= 0 ? boundarySeq : undefined,
    boundaryTime: boundaryTime || Date.now(),
    completedTurns,
    excludedInflight,
    empty: messages.length === 0,
    truncated: trimmed.truncated,
    omittedMessages: trimmed.omitted,
    estimatedTokens: trimmed.tokens,
    contextWindow,
    route: selected,
    parentLabel: firstUserLabel(messages) ?? shortId(parentSessionId),
    messages,
    /** First kept surface node, so a seeded Session can start exactly there. */
    firstKeptSeq: trimmed.entries[0]?.seq,
  }
}

/**
 * Route inheritance, in the same precedence the main session itself will use.
 *
 * 1. The session's most recent `model/selection` event. That is what the
 *    composer's model seat displays and what an `agent/request` listener applies
 *    to the next request, so it is the only source that stays consistent with
 *    the main session when the user switched model without sending yet.
 * 2. The last logged request header, for sessions that never recorded a switch.
 * 3. The process default.
 *
 * @param {object} ctx - host context.
 * @param {object} session - live parent session.
 * @returns {{provider?: string, model?: string, reasoningEffort?: string}} route.
 */
export function selectRoute(ctx, session) {
  try {
    const events = session.ownEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'model/selection') continue
      const selection = event.data
      if (selection?.provider && selection?.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      }
      break
    }
  } catch {
    /* fall through to the logged header */
  }

  let config
  try {
    config = session.requestHeader?.()?.config
  } catch {
    config = undefined
  }
  if (config?.provider && config?.model) {
    return {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    }
  }
  const fallback = ctx.get('agentDefaultModel')?.currentSelection?.()
  if (fallback?.provider && fallback?.model) {
    return {
      provider: fallback.provider,
      model: fallback.model,
      ...(fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {}),
    }
  }
  return {}
}

/**
 * Resolve the model input budget. Never invents a character-to-token rule: the
 * adapter's own context window, minus a reservation for the answer and for the
 * discussion's own growing history.
 */
async function resolveContextWindow(ctx, route, log) {
  const llm = ctx.get('llm')
  if (!llm || !route.provider || !route.model) return undefined
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model)
    const window = info?.context?.contextWindow
    if (typeof window !== 'number' || window <= 0) return undefined
    const answer = typeof info?.defaultMaxTokens === 'number' ? info.defaultMaxTokens : FALLBACK_ANSWER_TOKENS
    return { contextWindow: window, budget: Math.max(1024, window - answer - DISCUSSION_RESERVE_TOKENS) }
  } catch (error) {
    log({ stage: 'resolve-model', error: String(error?.message ?? error) })
    return undefined
  }
}

/**
 * Trim the inherited prefix to the budget by dropping the OLDEST messages.
 * Dropping breaks prefix reuse, which the design accepts as the necessary cost
 * of staying inside the window; it is reported to the user rather than hidden.
 * A leading tool result is dropped too, so the request never starts with an
 * orphan answer to a call the model can no longer see.
 */
function trimToBudget(ctx, entries, resolved, log) {
  const meter = ctx.get('tokenMeter')
  const sizes = entries.map((entry) => {
    if (!meter) return 0
    try {
      return meter.estimateMessage(entry.message) ?? 0
    } catch {
      return 0
    }
  })
  let total = sizes.reduce((sum, size) => sum + size, 0)
  if (!resolved || entries.length === 0) {
    return { entries, truncated: false, omitted: 0, tokens: total }
  }
  const { budget } = resolved
  if (budget <= 0 || total <= budget) return { entries, truncated: false, omitted: 0, tokens: total }
  let start = 0
  while (start < entries.length - 1 && total > budget) {
    total -= sizes[start]
    start += 1
  }
  while (start < entries.length - 1 && entries[start]?.message?.role === 'tool') {
    total -= sizes[start]
    start += 1
  }
  log({ stage: 'trim', omitted: start, tokens: total })
  return { entries: entries.slice(start), truncated: start > 0, omitted: start, tokens: total }
}

/** A short human label for the parent session, taken from its own first prompt. */
function firstUserLabel(messages) {
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const text = (message.content ?? [])
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text) return text.length > 48 ? `${text.slice(0, 47)}…` : text
  }
  return undefined
}

function shortId(id) {
  const text = String(id ?? '')
  return text.length > 14 ? `${text.slice(0, 14)}…` : text
}
