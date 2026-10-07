import { parentPort, workerData } from 'node:worker_threads'
import { compileGlob } from './glob-pattern.js'

// Model-supplied regular expressions execute only on this disposable thread.
let regex
let glob
try {
  if (workerData.mode === 'glob') glob = compileGlob(workerData.pattern)
  else regex = new RegExp(workerData.pattern, 'g')
} catch (error) {
  parentPort.postMessage({ error: `正则表达式无效：${error.message}` })
}
if (regex || glob) parentPort.on('message', ({ text, limit }) => {
  const hits = []
  if (glob) {
    for (let index = 0; index < text.length && hits.length < limit; index += 1) {
      if (glob(text[index])) hits.push(index)
    }
    parentPort.postMessage({ hits })
    return
  }
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
    regex.lastIndex = 0
    if (regex.test(lines[index])) hits.push(`${index + 1}:${lines[index]}`)
  }
  parentPort.postMessage({ hits })
})
