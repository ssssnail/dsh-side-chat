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

const marker = '\n（部分旧上下文或工具正文已裁剪；缺失信息不能视为已核实。）'

/** Keep protected instructions/current question, discard old groups atomically. */
export function fitMessages(messages, tools, budget, protectedMessages = []) {
  if (!budget || budget.estimate(messages, tools) <= budget.limit) return { messages, trimmed: false }
  const protectedSet = new Set(protectedMessages)
  let output = [...messages]
  // Oversized tool results are the common source of growth inside a single turn.
  for (let i = 0; i < output.length; i++) {
    const entry = output[i]
    if (entry.role !== 'tool' || protectedSet.has(entry)) continue
    const content = entry.content.map(block => block.type === 'text' && block.text.length > 800
      ? { ...block, text: block.text.slice(0, 600) + marker + '\n' + block.text.slice(-160) }
      : block)
    output[i] = { ...entry, content }
  }
  const notice = { role: 'user', content: [{ type: 'text', text: marker.trim() }] }
  output.unshift(notice)
  protectedSet.add(notice)
  while (budget.estimate(output, tools) > budget.limit) {
    const index = output.findIndex(entry => !protectedSet.has(entry))
    if (index < 0) {
      const error = new Error('当前问题与必要指令超过模型上下文容量，请缩短问题或选择上下文更大的模型。')
      error.code = 'context-too-large'
      throw error
    }
    const removed = output.splice(index, 1)[0]
    const ids = new Set((removed.content ?? []).filter(block => block.type === 'tool-call').map(block => block.id))
    if (ids.size) output = output.filter(entry => entry.role !== 'tool' || !ids.has(entry.toolCallId))
  }
  return { messages: output, trimmed: true }
}

/** Bound a summary transcript too; never send an oversized compression request. */
export function fitTranscript(text, instructions, budget) {
  let value = text
  const build = () => [...instructions, { role: 'user', content: [{ type: 'text', text: value }] }]
  if (budget) {
    while (budget.estimate(build()) > budget.limit && value.length > 256) {
      value = marker + '\n' + value.slice(Math.ceil(value.length / 4))
    }
  }
  const messages = build()
  return fitMessages(messages, undefined, budget, messages).messages
}
