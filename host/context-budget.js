/** Request-local budgeting. Never mutates the inherited session or UI history. */
export async function resolveBudget(ctx, route) {
  const meter = ctx.get?.('tokenMeter') ?? ctx.tokenMeter
  const info = await ctx.llm.resolveModelInfo(route.provider, route.model)
  const window = info?.context?.contextWindow
  if (!meter || !Number.isFinite(window) || window <= 0) return null
  const maxTokens = Math.max(1, Math.min(info.defaultMaxTokens ?? 8192, Math.floor(window / 4)))
  const limit = Math.floor(window - maxTokens - Math.min(2048, window * 0.08))
  return {
    maxTokens, limit,
    estimate(messages, tools) {
      let total = messages.reduce((sum, entry) => sum + meter.estimateMessage(entry) + 8, 0)
      if (tools?.length) total += meter.estimateMessage({ role: 'system', content: [{ type: 'text', text: JSON.stringify(tools) }] }) + 64
      return total
    },
  }
}

/** Reject over-capacity input without silently discarding evidence. */
export function fitMessages(messages, tools, budget) {
  if (budget && budget.estimate(messages, tools) > budget.limit) {
    const error = new Error('当前讨论内容过长，请重新打开临时会话。重新打开会清空本次讨论，并获取主会话的最新上下文。')
    error.code = 'context-too-large'
    throw error
  }
  return { messages }
}

/** A summary must see its full source; failure leaves discussion history intact. */
export function fitTranscript(text, instructions, budget) {
  const messages = [...instructions, { role: 'user', content: [{ type: 'text', text }] }]
  return fitMessages(messages, undefined, budget).messages
}
