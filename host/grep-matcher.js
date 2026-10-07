import { Worker } from 'node:worker_threads'

const MATCH_TIMEOUT_MS = 1000

export function createGrepMatcher(pattern, signal) { return createMatcher(pattern, signal, 'grep') }
export function createGlobMatcher(pattern, signal) { return createMatcher(pattern, signal, 'glob') }

/** One matcher per search call; serial batches, bounded execution, no filesystem access. */
function createMatcher(pattern, signal, mode) {
  signal?.throwIfAborted()
  const worker = new Worker(new URL('./grep-worker.js', import.meta.url), {
    workerData: { pattern, mode },
    resourceLimits: { maxOldGenerationSizeMb: 64 },
  })
  let pending
  let failure
  let disposed = false
  const fail = (error) => {
    failure = error
    pending?.reject(error)
    pending = undefined
    worker.terminate().catch(() => {})
  }
  worker.on('message', (result) => {
    if (result.error) return fail(new Error(result.error))
    pending?.resolve(result.hits)
    pending = undefined
  })
  worker.on('error', fail)
  worker.on('exit', (code) => {
    if (!disposed && !failure) fail(new Error(`搜索线程退出（${code}）。`))
  })
  const abort = () => fail(signal.reason ?? new Error('搜索已停止。'))
  signal?.addEventListener('abort', abort, { once: true })
  return {
    async match(text, limit) {
      if (failure) throw failure
      signal?.throwIfAborted()
      const result = new Promise((resolve, reject) => { pending = { resolve, reject } })
      const timer = setTimeout(() => fail(new Error('正则匹配超时，请简化搜索表达式。')), MATCH_TIMEOUT_MS)
      try {
        worker.postMessage({ text, limit })
        return await result
      } finally {
        clearTimeout(timer)
      }
    },
    async dispose() {
      disposed = true
      signal?.removeEventListener('abort', abort)
      await worker.terminate()
    },
  }
}
