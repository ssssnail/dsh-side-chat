/**
 * The temporary discussion runtime.
 *
 * One process-local instance per open panel, holding everything in memory:
 * the inherited snapshot prefix, the discussion-only instruction, the turns
 * produced so far, the per-request cancellation handles, and the request
 * statistics. Closing a discussion aborts its request, drops the record, and
 * leaves nothing behind — no Session is created, no session log is written, no
 * file is touched.
 *
 * The model call goes straight to `ctx.llm.stream` WITHOUT a `sessionId`. That
 * one omission is deliberate: the harness's session-scoped `llm/stream`
 * listeners (checkpoint policy, session-title) all short-circuit on a missing
 * session id, so a discussion request cannot perturb the main session's
 * durability checkpoints or its title derivation.
 */

import { randomUUID } from 'node:crypto'
import { discussionInstruction, DISCUSSION_RULES } from './prompt.js'
import { captureSnapshot } from './snapshot.js'
import { createReadOnlyToolbox, READ_ONLY_TOOL_NAMES } from './readonly-tools.js'

/** Maximum tool rounds inside one discussion turn before the loop is cut short. */
const MAX_TOOL_ROUNDS = 4
/** Consecutive all-failed tool rounds tolerated before the turn is ended. */
const MAX_FAILED_ROUNDS = 2
/** How many recent turns `/compact` keeps verbatim. */
const COMPACT_KEEP_TURNS = 2

/**
 * @param {object} ctx - host context (needs `llm`, and `sessions`/`fs` for snapshots and tools).
 * @param {object} [options] - `{ tools, log }`.
 * @returns {object} the runtime face used by the HTTP layer.
 */
export function createDiscussionRuntime(ctx, options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const toolsEnabled = options.tools !== false
  /** @type {Map<string, object>} */
  const discussions = new Map()

  /* ------------------------------------------------------------ lifecycle */

  async function open(input = {}) {
    const parentSessionId = String(input.parentSessionId ?? '')
    if (!parentSessionId) throw new Error('缺少 parentSessionId。')

    const snapshot = await captureSnapshot(ctx, parentSessionId, log)
    if (!snapshot.ok) {
      const error = new Error(snapshot.message)
      error.code = snapshot.code
      throw error
    }

    let toolbox = null
    if (toolsEnabled && snapshot.cwd) {
      try {
        toolbox = await createReadOnlyToolbox(ctx, snapshot.cwd)
      } catch (error) {
        log({ stage: 'toolbox', error: String(error?.message ?? error) })
        toolbox = null
      }
    }

    const id = `discussion-${randomUUID()}`
    const instruction = discussionInstruction(snapshot, {
      parentLabel: snapshot.parentLabel,
      parentSessionId,
      workspace: toolbox?.workspace ?? snapshot.cwd,
      toolNames: toolbox ? [...READ_ONLY_TOOL_NAMES] : [],
    })
    const instructionMessage = message('developer', instruction, { kind: 'side-chat' })

    // The discussion is a real Session so the harness's own Conversation, chat
    // and usage components can render it. It is created OUTSIDE the agent
    // lifecycle (prepare + enter + announce), which the session store documents
    // as persisting nothing: no log writer is ever attached. `detach` removes it
    // from the store again, so closing the discussion destroys it.
    const sessionId = `discussion-${randomUUID()}`
    let session
    let detachSession
    let seededTurnNumber = 0
    try {
      const parent = ctx.get('sessions')?.get(parentSessionId)
      seededTurnNumber = seededTurn(parent, snapshot.boundarySeq)
      const from = snapshot.firstKeptSeq ?? 0
      const to = (snapshot.boundarySeq ?? -1) + 1
      const seed = parent && to > from ? [...parent.snapshotEvents(from, to)] : []
      const prepared = ctx.sessions.prepare(sessionId, {
        ...(seed.length > 0 ? { seed } : {}),
        ...(seed.length > 0 ? { inheritedEventCount: seed.length } : {}),
        meta: {
          ...(snapshot.cwd ? { cwd: snapshot.cwd } : {}),
          parentSession: parentSessionId,
          isSeeded: true,
        },
      })
      detachSession = ctx.sessions.enter(prepared)
      ctx.sessions.announce(prepared)
      session = prepared
      log({ stage: 'session', discussionId: id, sessionId, seeded: seed.length })
    } catch (error) {
      // Without a Session the discussion still runs over its own event stream;
      // only the reused chat components are unavailable.
      log({ stage: 'session-failed', error: String(error?.message ?? error) })
      session = undefined
      detachSession = undefined
    }

    const discussion = {
      id,
      tag: typeof input.tag === 'string' ? input.tag : undefined,
      parentSessionId,
      parentLabel: snapshot.parentLabel,
      createdAt: Date.now(),
      prefix: snapshot.messages,
      rules: instructionMessage,
      session,
      sessionId,
      detachSession,
      // Continue the seeded turn numbering: the parent's turns are 1..N in the
      // Session's own log, so restarting at 1 would collide in the transcript.
      turn: seededTurnNumber,
      headerKey: undefined,
      summary: [],
      turns: [],
      steps: 0,
      route: snapshot.route,
      contextWindow: snapshot.contextWindow,
      toolbox,
      snapshot: {
        boundarySeq: snapshot.boundarySeq,
        boundaryTime: snapshot.boundaryTime,
        completedTurns: snapshot.completedTurns,
        excludedInflight: snapshot.excludedInflight,
        empty: snapshot.empty,
        truncated: snapshot.truncated,
        omittedMessages: snapshot.omittedMessages,
        estimatedTokens: snapshot.estimatedTokens,
        contextWindow: snapshot.contextWindow,
      },
      busy: null,
      compactRequested: false,
      seenRequests: new Set(),
      stats: [],
      closed: false,
    }
    discussions.set(id, discussion)
    log({ stage: 'open', discussionId: id, parentSessionId, turns: snapshot.completedTurns })
    return view(discussion)
  }

  /** Idempotent close: unknown or already-closed ids succeed. */
  function close(discussionId) {
    const discussion = discussions.get(discussionId)
    if (!discussion) return { ok: true, alreadyClosed: true }
    discussion.closed = true
    try {
      discussion.busy?.controller?.abort(cancelReason('instance-closed'))
    } catch {
      /* an already-settled controller cannot fail the close */
    }
    discussion.busy = null
    discussion.prefix = []
    discussion.summary = []
    discussion.turns = []
    discussion.toolbox = null
    try {
      discussion.detachSession?.()
    } catch (error) {
      log({ stage: 'detach', error: String(error?.message ?? error) })
    }
    discussion.detachSession = undefined
    discussion.session = undefined
    discussions.delete(discussionId)
    log({ stage: 'close', discussionId })
    return { ok: true, alreadyClosed: false }
  }

  function closeAll() {
    for (const id of [...discussions.keys()]) close(id)
  }

  function require(discussionId) {
    const discussion = discussions.get(discussionId)
    if (!discussion) {
      const error = new Error('讨论实例已关闭或不存在。')
      error.code = 'discussion-gone'
      throw error
    }
    return discussion
  }

  /* --------------------------------------------------------------- models */

  async function listModels() {
    const llm = ctx.get('llm')
    if (!llm) return { providers: [] }
    const providers = (llm.listProviders?.() ?? []).map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.id,
    }))
    const models = {}
    for (const provider of providers) {
      try {
        const listed = await llm.listModels(provider.id)
        models[provider.id] = (listed ?? []).map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
        }))
      } catch (error) {
        log({ stage: 'list-models', provider: provider.id, error: String(error?.message ?? error) })
        models[provider.id] = []
      }
    }
    return { providers, models }
  }

  function setModel(discussionId, route = {}) {
    const discussion = require(discussionId)
    const provider = String(route.provider ?? '')
    const model = String(route.model ?? '')
    if (!provider || !model) throw new Error('切换模型需要 provider 与 model。')
    // Only affects later requests; the running request keeps its captured route.
    discussion.route = {
      provider,
      model,
      ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
    }
    log({ stage: 'model', discussionId, provider, model })
    return { ok: true, route: { ...discussion.route } }
  }

  /* ---------------------------------------------------------------- turns */

  /**
   * Run one discussion turn, streaming protocol events through `emit`.
   *
   * @param {object} input - `{ discussionId, requestId, text }`.
   * @param {(event: object) => void} emit - per-event sink (already instance-scoped).
   * @returns {Promise<object>} the settled turn summary.
   */
  async function send(input = {}, sink = () => {}) {
    const discussion = require(input.discussionId)
    const requestId = String(input.requestId ?? '')
    /** Every streamed event names its instance and request before anything else. */
    const emit = (event) => sink({ discussionId: discussion.id, requestId, ...event })
    const text = String(input.text ?? '').trim()
    if (!requestId) throw new Error('缺少 requestId。')
    if (!text) throw new Error('讨论问题为空。')
    if (discussion.busy) {
      const error = new Error('讨论区正在生成回答，请先停止或等待完成。')
      error.code = 'discussion-busy'
      throw error
    }
    if (discussion.seenRequests.has(requestId)) {
      const error = new Error('该请求已处理，未重复执行。')
      error.code = 'duplicate-request'
      throw error
    }
    discussion.seenRequests.add(requestId)

    const controller = new AbortController()
    discussion.busy = { requestId, controller }

    const route = { ...discussion.route }
    if (!route.provider || !route.model) {
      discussion.busy = null
      const error = new Error('没有可用的模型路由：主会话未记录模型，且没有默认模型。')
      error.code = 'no-route'
      throw error
    }

    const questionMessage = { role: 'user', content: [{ type: 'text', text }] }
    const turn = {
      requestId,
      question: text,
      questionMessage,
      answerMessages: [],
      text: '',
      status: 'running',
      route,
      stats: null,
    }

    const startedAt = Date.now()
    const stats = {
      provider: route.provider,
      model: route.model,
      inputTokens: undefined,
      outputTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
      cacheReported: false,
      ttfbMs: null,
      totalMs: null,
      toolCalls: 0,
    }

    let firstTokenAt = 0
    const parts = []
    let streamError = null

    const session = discussion.session
    const turnNumber = (discussion.turn ?? 0) + 1
    discussion.turn = turnNumber
    // Tool calls of the current step that have no result yet. A turn can stop
    // between the two (user stop, round cap, a refusal), and a provider rejects
    // a history whose assistant tool call is unanswered, so they are closed in
    // the finally block below.
    let unresolved = []
    let unresolvedStep = 1
    let openStep = 0

    try {
      if (session) {
        appendSafe(session, 'turn/start', { turn: turnNumber }, undefined, log)
        if (!discussion.instructionAppended) {
          appendSafe(session, 'developer/message', { turn: turnNumber, step: 1, message: discussion.rules }, { surfaceOp: 'append' }, log)
          discussion.instructionAppended = true
        }
        appendSafe(
          session,
          'user/message',
          { id: questionMessage.id ?? newId(), role: 'user', content: questionMessage.content, source: { kind: 'user' } },
          { surfaceOp: 'append' },
          log,
        )
      }
      const messages = messagesFor(discussion, questionMessage)
      // One signature per call that has already failed, so an identical retry
      // is refused instead of executed again.
      const failedCalls = discussion.failedCalls ?? (discussion.failedCalls = new Set())
      let failedRounds = 0
      for (let round = 0; ; round += 1) {
        discussion.steps += 1
        const step = round + 1
        if (session && openStep) {
          appendSafe(session, 'step/end', { turn: turnNumber, step: openStep }, undefined, log)
          openStep = 0
        }
        if (session) {
          appendSafe(session, 'step/start', { turn: turnNumber, step }, undefined, log)
          openStep = step
        }
        if (session) {
          const headerKey = `${route.provider}/${route.model}/${route.reasoningEffort ?? ''}/${discussion.toolbox ? 'tools' : 'none'}`
          if (discussion.headerKey !== headerKey) {
            const tools = discussion.toolbox ? [...discussion.toolbox.schemas] : undefined
            appendSafe(
              session,
              'request/header',
              {
                header: {
                  config: {
                    provider: route.provider,
                    model: route.model,
                    ...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
                  },
                  ...(tools ? { tools } : {}),
                },
                reason: discussion.headerKey === undefined ? 'initial' : 'change',
                ...(discussion.headerKey === undefined ? { startsSeries: true } : {}),
              },
              undefined,
              log,
            )
            discussion.headerKey = headerKey
          }
        }
        const attempt = session ? createLiveAttempt(ctx, session, turnNumber, step, discussion, log) : undefined
        if (attempt) attempt.start()
        const records = []
        const request = {
          provider: route.provider,
          model: route.model,
          // With a Session the request is derived from its own log — the seeded
          // inherited prefix, the discussion instruction and this turn's events
          // — which is what keeps the main session's request prefix reusable.
          messages: session ? session.deriveMessages() : [...messages],
          signal: controller.signal,
        }
        if (route.reasoningEffort) request.reasoningEffort = route.reasoningEffort
        if (discussion.toolbox) request.tools = discussion.toolbox.schemas

        const blocks = new Map()
        let finish = null
        let roundText = ''
        let roundReasoning = ''

        const stream = ctx.llm.stream(request)
        for await (const chunk of stream) {
          if (attempt) attempt.push(chunk)
          records.push({ type: 'chunk', time: Date.now(), chunk })
          if (chunk.type === 'text-delta') {
            if (firstTokenAt === 0) {
              firstTokenAt = Date.now()
              stats.ttfbMs = firstTokenAt - startedAt
            }
            roundText += chunk.text
            pushText(parts, chunk.text)
            emit({ type: 'text', text: chunk.text })
            continue
          }
          if (chunk.type === 'reasoning-delta') {
            if (firstTokenAt === 0) {
              firstTokenAt = Date.now()
              stats.ttfbMs = firstTokenAt - startedAt
            }
            roundReasoning += chunk.text
            emit({ type: 'reasoning', text: chunk.text })
            continue
          }
          if (chunk.type === 'usage') {
            absorbUsage(stats, chunk.usage)
            continue
          }
          if (chunk.type === 'block-end') {
            blocks.set(chunk.index, chunk.block)
            continue
          }
          if (chunk.type === 'finish') finish = chunk.reason
        }

        const content = [...blocks.entries()]
          .sort((left, right) => left[0] - right[0])
          .map(([, block]) => block)
        if (content.length === 0) {
          if (roundText) content.push({ type: 'text', text: roundText })
          else if (roundReasoning) content.push({ type: 'reasoning', text: roundReasoning })
        }
        const assistant = {
          id: newId(),
          role: 'assistant',
          source: { kind: 'model', provider: route.provider, model: route.model },
          content,
        }
        turn.answerMessages.push(assistant)
        messages.push(assistant)
        const stoppedHere = finish?.kind === 'aborted'
        const failedHere = finish?.kind === 'error'
        if (session) {
          const committed = appendSafe(
            session,
            'assistant/message',
            {
              turn: turnNumber,
              step,
              message: assistant,
              stream: records,
              ...(stats.inputTokens === undefined && stats.outputTokens === undefined ? {} : {
                usage: {
                  inputTokens: stats.inputTokens ?? 0,
                  outputTokens: stats.outputTokens ?? 0,
                  ...(stats.cacheReadTokens === undefined ? {} : { cacheReadTokens: stats.cacheReadTokens }),
                  ...(stats.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: stats.cacheWriteTokens }),
                },
              }),
              ...(stoppedHere ? { interrupted: true } : {}),
            },
            { surfaceOp: 'append' },
            log,
          )
          if (attempt) {
            if (committed) attempt.end({ kind: 'committed', eventType: 'assistant/message', seq: committed.seq })
            else attempt.end({ kind: 'abandoned' })
          }
        }


        const toolCalls = content.filter((block) => block?.type === 'tool-call')
        unresolved = toolCalls.map((call) => call.id)
        unresolvedStep = step

        if (finish?.kind === 'aborted') {
          turn.status = 'stopped'
          break
        }
        if (finish?.kind === 'error') {
          streamError = new Error(finish.failure?.message ?? '模型请求失败。')
          turn.status = 'error'
          emit({ type: 'error', message: streamError.message, code: finish.failure?.code })
          break
        }
        if (toolCalls.length === 0) {
          turn.status = 'done'
          break
        }
        if (!discussion.toolbox || round >= MAX_TOOL_ROUNDS) {
          emit({
            type: 'notice',
            level: 'warn',
            message: discussion.toolbox
              ? `工具调用轮次已达上限（${MAX_TOOL_ROUNDS}），本轮结束。`
              : '本次讨论未开放工具，已忽略模型提出的工具调用。',
          })
          turn.status = 'done'
          break
        }
        let roundFailures = 0
        let roundRefusals = 0
        for (const call of toolCalls) {
          stats.toolCalls += 1
          const signature = `${call.name}\u0000${call.arguments ?? ''}`
          emit({ type: 'tool', name: call.name, status: 'running' })
          let result
          if (failedCalls.has(signature)) {
            // The exact call already failed in this discussion; repeating it
            // cannot produce a different answer, so it is refused rather than
            // re-run. This is what stops a failing tool from becoming a loop.
            result = {
              text: `同一调用 ${call.name} 参数完全相同且已经失败过，不再重复执行。`,
              isError: true,
              refused: true,
            }
          } else {
            result = await discussion.toolbox.execute(call.name, call.arguments, controller.signal)
            if (result.isError) failedCalls.add(signature)
          }
          if (result.isError) roundFailures += 1
          if (result.refused) roundRefusals += 1
          parts.push({
            kind: 'tool',
            name: call.name,
            status: result.isError ? 'error' : 'done',
            text: previewText(result.text),
          })
          emit({
            type: 'tool',
            name: call.name,
            status: result.isError ? 'error' : 'done',
            text: previewText(result.text),
          })
          const toolResult = {
            id: newId(),
            role: 'tool',
            source: { kind: 'tool', callId: call.id },
            toolCallId: call.id,
            content: [{ type: 'text', text: result.text }],
            ...(result.isError ? { isError: true } : {}),
          }
          messages.push(toolResult)
          unresolved = unresolved.filter((id) => id !== call.id)
          if (session) {
            appendSafe(
              session,
              'tool/call',
              { turn: turnNumber, step, callId: call.id, name: call.name, arguments: call.arguments ?? '{}' },
              undefined,
              log,
            )
            appendSafe(session, 'tool/result', { turn: turnNumber, step, message: toolResult }, { surfaceOp: 'append' }, log)
          }
          if (controller.signal.aborted) {
            turn.status = 'stopped'
            break
          }
        }
        if (turn.status === 'stopped') break
        // Every call in this round hit a capability boundary (a tool this
        // session does not declare, or a path outside the workspace). Asking the
        // model again cannot help, so the turn ends with a professional notice
        // instead of a retry loop.
        if (roundRefusals > 0 && roundRefusals === toolCalls.length) {
          emit({ type: 'notice', level: 'warn', message: '已按只读范围拒绝这些调用，本轮结束。' })
          turn.status = 'done'
          break
        }
        failedRounds = roundFailures === toolCalls.length ? failedRounds + 1 : 0
        if (failedRounds >= MAX_FAILED_ROUNDS) {
          emit({
            type: 'notice',
            level: 'warn',
            message: '只读工具连续失败，已结束本轮：请直接说明结论或缺少的信息。',
          })
          turn.status = 'done'
          break
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        turn.status = 'stopped'
      } else {
        streamError = error
        turn.status = 'error'
        emit({ type: 'error', message: String(error?.message ?? error) })
      }
      log({ stage: 'send', discussionId: discussion.id, error: String(error?.message ?? error) })
    } finally {
      stats.totalMs = Date.now() - startedAt
      turn.text = collectText(turn.answerMessages, parts)
      turn.stats = stats
      discussion.stats.push(stats)
      discussion.turns.push(turn)
      discussion.busy = null
      if (session && openStep) {
        appendSafe(session, 'step/end', { turn: turnNumber, step: openStep }, undefined, log)
        openStep = 0
      }
      if (session) {
        for (const callId of unresolved) {
          appendSafe(
            session,
            'tool/result',
            {
              turn: turnNumber,
              step: unresolvedStep,
              message: {
                id: newId(),
                role: 'tool',
                source: { kind: 'tool', callId },
                toolCallId: callId,
                content: [{ type: 'text', text: '（该调用未完成：本轮已结束。）' }],
                isError: true,
              },
            },
            { surfaceOp: 'append' },
            log,
          )
        }
        unresolved = []
        appendSafe(
          session,
          'turn/end',
          {
            turn: turnNumber,
            reason:
              turn.status === 'stopped'
                ? { kind: 'aborted', reason: { kind: 'user' } }
                : turn.status === 'error'
                  ? { kind: 'error', error: { message: streamError?.message ?? 'discussion request failed', code: streamError?.code ?? 'error' } }
                  : { kind: 'completed' },
          },
          undefined,
          log,
        )
      }
    }

    emit({
      type: 'done',
      steps: discussion.steps,
      status: turn.status,
      text: turn.text,
      parts: parts.map((part) => ({ ...part })),
      stats: { ...stats },
      ...(streamError ? { message: streamError.message } : {}),
    })

    if (discussion.compactRequested && !discussion.closed) {
      discussion.compactRequested = false
      compact(discussion.id).catch((error) =>
        log({ stage: 'compact-after-turn', error: String(error?.message ?? error) }),
      )
    }
    return { requestId, status: turn.status, stats }
  }

  function cancel(discussionId, requestId) {
    const discussion = discussions.get(discussionId)
    if (!discussion) return { ok: true, cancelled: false, reason: 'discussion-gone' }
    const busy = discussion.busy
    if (!busy) return { ok: true, cancelled: false, reason: 'idle' }
    if (requestId && busy.requestId !== requestId) {
      return { ok: true, cancelled: false, reason: 'request-mismatch' }
    }
    busy.controller.abort(cancelReason('user-stop'))
    log({ stage: 'cancel', discussionId, requestId: busy.requestId })
    return { ok: true, cancelled: true, requestId: busy.requestId }
  }

  /* ------------------------------------------------------------ compaction */

  /**
   * Compress the discussion's OWN history into one summary, keeping the most
   * recent turns verbatim. The inherited reference prefix is never touched and
   * the main session is never read again.
   */
  async function compact(discussionId) {
    const discussion = require(discussionId)
    if (discussion.busy) {
      discussion.compactRequested = true
      return { ok: true, queued: true }
    }
    const turns = discussion.turns
    if (turns.length <= COMPACT_KEEP_TURNS) return { ok: true, compacted: false, reason: 'too-short' }

    const older = turns.slice(0, turns.length - COMPACT_KEEP_TURNS)
    const keep = turns.slice(turns.length - COMPACT_KEEP_TURNS)
    const route = discussion.route
    if (!route.provider || !route.model) return { ok: false, message: '没有可用模型进行压缩。' }

    const transcript = older
      .map((turn) => `【讨论问题】\n${turn.question}\n\n【讨论回答】\n${turn.text}`)
      .join('\n\n---\n\n')
    const controller = new AbortController()
    let summary = ''
    try {
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        messages: [
          message('developer', DISCUSSION_RULES, { kind: 'side-chat' }),
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text:
                  '请把下面这段临时讨论压缩成要点摘要，保留结论、方案差异、未决问题与相关文件路径，' +
                  '省略寒暄和重复内容。只输出摘要正文。\n\n' +
                  transcript,
              },
            ],
          },
        ],
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') summary += chunk.text
      }
    } catch (error) {
      return { ok: false, message: `压缩失败：${error?.message ?? error}` }
    }
    if (!summary.trim()) return { ok: false, message: '压缩没有产生摘要。' }

    discussion.summary.push(
      message('developer', `【较早的临时讨论摘要（已压缩）】\n${summary.trim()}`, { kind: 'side-chat' }),
    )
    discussion.turns = keep
    log({ stage: 'compact', discussionId, compressedTurns: older.length, keptTurns: keep.length })
    return { ok: true, compacted: true, compressedTurns: older.length, keptTurns: keep.length }
  }

  /* ---------------------------------------------------------------- views */

  function view(discussion) {
    return {
      discussionId: discussion.id,
      sessionId: discussion.sessionId,
      parentSessionId: discussion.parentSessionId,
      parentLabel: discussion.parentLabel,
      createdAt: discussion.createdAt,
      snapshotTime: discussion.snapshot.boundaryTime,
      completedTurns: discussion.snapshot.completedTurns,
      excludedInflight: discussion.snapshot.excludedInflight,
      empty: discussion.snapshot.empty,
      truncated: discussion.snapshot.truncated,
      omittedMessages: discussion.snapshot.omittedMessages,
      estimatedTokens: discussion.snapshot.estimatedTokens,
      contextWindow: discussion.snapshot.contextWindow,
      workspace: discussion.toolbox?.workspace ?? null,
      tools: discussion.toolbox ? [...READ_ONLY_TOOL_NAMES] : [],
      route: { ...discussion.route },
      generating: Boolean(discussion.busy),
      stats: discussion.stats.map((entry) => ({ ...entry })),
      steps: discussion.steps,
    }
  }

  function get(discussionId) {
    const discussion = discussions.get(discussionId)
    return discussion ? view(discussion) : undefined
  }

  return {
    open,
    send,
    cancel,
    close,
    closeAll,
    compact,
    setModel,
    listModels,
    get,
    list: () => [...discussions.values()].map(view),
  }
}

/* ------------------------------------------------------------------ helpers */

/**
 * Append one durable session event, never letting a shape problem fail a turn:
 * the discussion's own SSE view must keep working even if an event is refused.
 */
function appendSafe(session, type, data, intent, log) {
  if (!session) return undefined
  try {
    return intent === undefined ? session.append(type, data) : session.append(type, data, intent)
  } catch (error) {
    log?.({ stage: 'append', type, error: String(error?.message ?? error) })
    return undefined
  }
}

/**
 * The live attempt frames the agent loop publishes (`agent/assistant-stream`):
 * `{type:'start'|'chunk'|'end', attemptId, revision, index, turn, step, chunk}`.
 * The client turns them into `assistant/live-chunk`, which is what makes an
 * answer stream token by token into the real chat components.
 */
function createLiveAttempt(ctx, session, turn, step, discussion, log) {
  const attemptId = `${session.id}:${(discussion.attemptCounter = (discussion.attemptCounter ?? 0) + 1)}`
  let revision = 0
  let index = 0
  const emitFrame = (frame) => {
    try {
      ctx.emit('agent/assistant-stream', { frame })
    } catch (error) {
      log?.({ stage: 'live-frame', error: String(error?.message ?? error) })
    }
  }
  return {
    start() {
      emitFrame({ type: 'start', attemptId, revision: revision++, turn, step })
    },
    push(chunk) {
      emitFrame({ type: 'chunk', attemptId, revision: revision++, index: index++, time: Date.now(), chunk })
    },
    end(outcome) {
      emitFrame({ type: 'end', attemptId, revision: revision++, index, outcome })
    },
  }
}

/** The highest turn number the seeded prefix ends with, so numbering continues. */
function seededTurn(parent, boundarySeq) {
  if (!parent || boundarySeq === undefined) return 0
  let turn = 0
  for (const event of parent.ownEvents?.() ?? []) {
    if (event.seq > boundarySeq) break
    const value = event.data?.turn
    if (typeof value === 'number' && value > turn) turn = value
  }
  return turn
}

/** Build the exact message array for one request: prefix, rules, turns, question. */
function messagesFor(discussion, questionMessage) {
  const messages = [...discussion.prefix, discussion.rules, ...discussion.summary]
  for (const turn of discussion.turns) {
    messages.push(turn.questionMessage)
    for (const answer of turn.answerMessages) messages.push(answer)
  }
  if (questionMessage) messages.push(questionMessage)
  return closeUnresolvedToolCalls(messages)
}

/**
 * A provider requires every assistant tool call to be answered before the next
 * non-tool turn. A turn can stop between the two — the user stops it, the round
 * cap trips, or the stream ends mid-round — and an unanswered call would then
 * fail the *whole next request* with "tool calls need immediate results". Any
 * call still open is closed here with a synthetic result instead.
 */
function closeUnresolvedToolCalls(messages) {
  const closed = []
  let pending = []
  const closePending = () => {
    for (const id of pending) {
      closed.push({
        id: newId(),
        role: 'tool',
        source: { kind: 'tool', callId: id },
        toolCallId: id,
        content: [{ type: 'text', text: '（该工具调用未完成，讨论区已补记结果。）' }],
        isError: true,
      })
    }
    pending = []
  }
  for (const message of messages) {
    if (message.role === 'assistant') {
      closePending()
      pending = (message.content ?? []).filter((block) => block?.type === 'tool-call').map((block) => block.id)
      closed.push(message)
      continue
    }
    if (message.role === 'tool') {
      pending = pending.filter((id) => id !== message.toolCallId)
      closed.push(message)
      continue
    }
    closePending()
    closed.push(message)
  }
  closePending()
  return closed
}

function message(role, text, source) {
  return {
    id: newId(),
    role,
    content: [{ type: 'text', text }],
    source: source ?? { kind: 'side-chat' },
  }
}

function newId() {
  return randomUUID()
}

function pushText(parts, text) {
  const last = parts[parts.length - 1]
  if (last && last.kind === 'text') last.text += text
  else parts.push({ kind: 'text', text })
}

/** The user-facing answer body: every text block produced across tool rounds. */
function collectText(answerMessages, parts) {
  const fromParts = parts
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .join('')
  if (fromParts.trim()) return fromParts
  const blocks = []
  for (const answer of answerMessages) {
    for (const block of answer.content ?? []) {
      if (block?.type === 'text' && block.text) blocks.push(block.text)
    }
  }
  return blocks.join('')
}

function absorbUsage(stats, usage) {
  if (!usage) return
  if (typeof usage.inputTokens === 'number') stats.inputTokens = usage.inputTokens
  if (typeof usage.outputTokens === 'number') stats.outputTokens = usage.outputTokens
  if (typeof usage.reasoningTokens === 'number') stats.reasoningTokens = usage.reasoningTokens
  if (typeof usage.cacheReadTokens === 'number') {
    stats.cacheReadTokens = usage.cacheReadTokens
    stats.cacheReported = true
  }
  if (typeof usage.cacheWriteTokens === 'number') {
    stats.cacheWriteTokens = usage.cacheWriteTokens
    stats.cacheReported = true
  }
}

function previewText(text) {
  const flat = String(text ?? '')
  return flat.length > 400 ? `${flat.slice(0, 400)}…` : flat
}

function cancelReason(kind) {
  const error = new Error(kind === 'user-stop' ? '用户停止讨论回答。' : '讨论实例已关闭。')
  error.name = 'SideChatAbort'
  return error
}
