/**
 * Real-backend test for the read-only toolbox.
 *
 * Unlike `dry-run.mjs` (which fakes the filesystem), this instantiates the
 * harness's own `dsh-fs-local` service and runs the plugin's `read`/`glob`/
 * `grep` against the real disk, so path resolution, containment and encoding
 * behaviour are the production ones. It is a local diagnostic, not part of
 * `npm test`: it reaches into the installed harness by absolute path.
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const HARNESS = process.env.DSH_HARNESS_DIR
  ?? '/Users/snail/.local/share/pi-node/node-v22.23.2-darwin-x64/lib/node_modules/@deepseek-ai/dsh'

const require = createRequire(`${HARNESS}/node_modules/@deepseek-ai/dsh-fs-local/`)
const { LocalFileSystem } = require('@deepseek-ai/dsh-fs-local')
const { Context } = require('@deepseek-ai/cordis')

const { createReadOnlyToolbox } = await import('../host/readonly-tools.js')

const workspace = '/Users/snail/projects/side-chat'

const root = new Context()
// schemastery normally applies these defaults; construct with them explicitly.
const fs = new LocalFileSystem(root, { cwd: workspace, diffBasisMaxBytes: 16 * 1024 * 1024 })

const ctx = { get: (name) => (name === 'fs' ? fs : undefined) }

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

console.log('\nread-only toolbox against the real filesystem\n')
const box = await createReadOnlyToolbox(ctx, workspace)

await check('resolves the bound workspace and reports it', () => {
  assert.equal(box.workspace, workspace)
  assert.deepEqual([...box.names], ['read', 'glob', 'grep'])
})

await check('reads a relative path inside the workspace', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: 'package.json' }), undefined)
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /"name": "@local\/dsh-side-chat"/)
})

await check('reads an absolute path inside the workspace', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: `${workspace}/index.js` }), undefined)
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /PLUGIN_REVISION/)
})

await check('honours offset and limit', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: 'package.json', offset: 2, limit: 1 }), undefined)
  assert.equal(result.isError, false, result.text)
  // One content line plus the trailing "shown up to line N" note.
  assert.match(result.text.split('\n')[0], /^2\t/)
  assert.match(result.text, /共 \d+ 行/)
})

await check('refuses an absolute path outside the workspace', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: '/etc/hosts' }), undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /不在本次会话可访问的工作区内/)
})

await check('refuses an escaping relative path', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: '../../../../etc/hosts' }), undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /不在本次会话可访问的工作区内/)
})

await check('refuses a symlink inside the workspace that resolves outside', async () => {
  const { symlinkSync, unlinkSync, existsSync } = await import('node:fs')
  const link = `${workspace}/test/.escape-link`
  if (existsSync(link)) unlinkSync(link)
  symlinkSync('/etc/hosts', link)
  try {
    const viaLink = await box.execute('read', JSON.stringify({ file_path: 'test/.escape-link' }), undefined)
    assert.equal(viaLink.isError, true, `expected a refusal, got: ${viaLink.text.slice(0, 120)}`)
    assert.match(viaLink.text, /不在本次会话可访问的工作区内/)
    const viaReal = await box.execute('read', JSON.stringify({ file_path: '/etc/hosts' }), undefined)
    assert.equal(viaReal.isError, true)
  } finally {
    unlinkSync(link)
  }
})

await check('refuses a spill-style temp path from the inherited snapshot', async () => {
  // The scenario the user hit: the session snapshot names tool spill files
  // under the platform temp root, which is outside the bound workspace.
  const spill = '/var/folders/y1/8vmlq47s1msgghtw4rxx10hr0000gn/T/dsh-spill-DWkBvX/session-x/e591ab.txt'
  const result = await box.execute('read', JSON.stringify({ file_path: spill }), undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /不在本次会话可访问的工作区内/)
  assert.match(result.text, /可访问范围：/)
})

await check('refuses a missing file with a readable reason', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: 'does-not-exist.txt' }), undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /文件不存在/)
})

await check('refuses read on a directory', async () => {
  const result = await box.execute('read', JSON.stringify({ file_path: 'host' }), undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /这是一个目录/)
})

await check('globs inside the workspace only', async () => {
  const result = await box.execute('glob', JSON.stringify({ pattern: '*.json' }), undefined)
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /package\.json/)
  assert.equal(result.text.includes('/etc/'), false)
})

await check('greps inside the workspace only', async () => {
  const result = await box.execute('grep', JSON.stringify({ pattern: 'PLUGIN_REVISION', include: '*.js' }), undefined)
  assert.equal(result.isError, false, result.text)
  assert.match(result.text, /index\.js/)
  assert.match(result.text, /3/)
})

await check('refuses a tool that is not whitelisted', async () => {
  const result = await box.execute('bash', JSON.stringify({ command: 'rm -rf /' }), undefined)
  assert.equal(result.isError, true)
  assert.match(result.text, /该工具在临时会话中不可用/)
})

console.log(`\n${failures.length === 0 ? 'all checks passed' : `${failures.length} check(s) failed`}\n`)
process.exit(failures.length === 0 ? 0 : 1)
