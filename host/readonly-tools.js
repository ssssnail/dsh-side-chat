/**
 * The discussion's read-only tool surface.
 *
 * Two layers, deliberately separate:
 *  1. Tool DECLARATIONS are the `read` / `glob` / `grep` schemas, copied
 *     verbatim from the harness so the model meets familiar shapes (and so the
 *     declared prefix stays close to the main session's own tool block).
 *  2. Tool EXECUTION is this module's own dispatcher. Nothing here reaches the
 *     Agent tool registry, the shell, or the approval pipeline: the only
 *     functions that exist are the three below, they read through `ctx.fs`, and
 *     every path is resolved and containment-checked against the bound
 *     workspace before any byte is read. Resolution yields a realpath-derived
 *     target key, so a symlink out of the workspace is rejected rather than
 *     followed.
 */

/** Declared tool names. Anything not in this set is refused before dispatch. */
export const READ_ONLY_TOOL_NAMES = Object.freeze(['read', 'glob', 'grep'])

/** Declarations sent to the provider. Identical shapes to the harness tools. */
export const READ_ONLY_TOOL_SCHEMAS = Object.freeze([
  {
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: 'Path to read, resolved by the filesystem backend.',
        },
        offset: {
          type: 'number',
          description: '1-based first line to return. Defaults to 1.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of lines to return. Defaults to 2000.',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'glob',
    description:
      'Find files, not directories, whose paths match a glob pattern. Returns up to 100 paths. A pattern with no "/" matches the basename at any depth; include a separator to anchor the depth.',
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Glob pattern to match file paths against (e.g. "**/*.ts").',
        },
        path: {
          type: 'string',
          description:
            'Directory to search in. Defaults to the bound workspace; a relative path resolves against it.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'grep',
    description:
      'Search file contents with a regular expression. Returns matching lines with line numbers, grouped by file, up to 250 matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: {
          type: 'string',
          description:
            'File or directory to search. Defaults to the bound workspace; a relative path resolves against it.',
        },
        include: {
          type: 'string',
          description: 'One glob filter for which files to search (e.g. "*.ts", "*.{js,jsx}").',
        },
      },
      required: ['pattern'],
    },
  },
])

const MAX_READ_BYTES = 4 * 1024 * 1024
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const MAX_WALK_ENTRIES = 60000
const GLOB_RESULTS = 100
const GREP_RESULTS = 250
const BINARY_SNIFF_BYTES = 4096

/** A refusal the model should read as a capability boundary, not a bug. */
export class ReadOnlyToolError extends Error {
  /**
   * @param message - what the model should read.
   * @param options.refused - true only for a capability boundary (the call can
   *   never succeed as asked). An ordinary fault such as a missing file leaves
   *   this false so the model may correct its arguments.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'ReadOnlyToolError'
    this.refused = options.refused === true
  }
}

/**
 * Build a toolbox bound to one workspace.
 *
 * @param {object} ctx - host context providing `fs`.
 * @param {string} workspacePath - absolute workspace root (the parent session's cwd).
 * @returns {Promise<object>} `{ schemas, names, execute, workspace }`.
 */
export async function createReadOnlyToolbox(ctx, workspacePath) {
  const fs = ctx.get('fs')
  if (!fs) throw new ReadOnlyToolError('文件服务不可用，无法开放只读工具。')
  if (typeof workspacePath !== 'string' || workspacePath.length === 0) {
    throw new ReadOnlyToolError('绑定工作区不可用，无法开放只读工具。')
  }
  const root = await fs.resolve(workspacePath)

  /** Resolve one user/model-supplied path and prove it stays inside the workspace. */
  async function inside(path, signal) {
    const raw = typeof path === 'string' && path.length > 0 ? path : '.'
    let target
    try {
      target = await fs.resolve(raw, { cwd: workspacePath, signal })
    } catch (error) {
      throw new ReadOnlyToolError(`无法解析路径 ${raw}：${error?.message ?? error}`)
    }
    if (target.targetKey !== root.targetKey && !fs.contains(root, target)) {
      // The snapshot a discussion inherits can name paths from the main
      // session that lie outside the bound workspace (tool spill files, temp
      // outputs, another checkout). Refusing is the contract; saying so in a
      // way that stops the model from walking the whole list is the courtesy.
      throw new ReadOnlyToolError(
        `该路径不在本次会话可访问的工作区内。可访问范围：${root.displayPath}；请求：${target.displayPath}`,
        { refused: true },
      )
    }
    return target
  }

  async function readFile(target, signal) {
    const info = await fs.stat(target, signal)
    if (!info) throw new ReadOnlyToolError(`文件不存在：${target.displayPath}`)
    if (info.type === 'directory') throw new ReadOnlyToolError(`这是一个目录：${target.displayPath}`)
    if (info.type !== 'file') throw new ReadOnlyToolError(`不是普通文件：${target.displayPath}`)
    if (typeof info.size === 'number' && info.size > MAX_READ_BYTES) {
      throw new ReadOnlyToolError(
        `文件过大（${info.size} 字节）。单次最多读取 ${MAX_READ_BYTES} 字节：${target.displayPath}`,
      )
    }
    return fs.readText(target, signal)
  }

  /** Depth-first walk inside the workspace, refusing anything that resolves out. */
  async function* walk(start, signal) {
    const queue = [start]
    let seen = 0
    while (queue.length > 0) {
      if (signal?.aborted) return
      const directory = queue.shift()
      let entries
      try {
        entries = await fs.listDir(directory, signal)
      } catch {
        continue
      }
      for (const entry of entries) {
        seen += 1
        if (seen > MAX_WALK_ENTRIES) return
        if (!entry?.target) continue
        if (entry.target.targetKey !== root.targetKey && !fs.contains(root, entry.target)) continue
        if (entry.type === 'directory') {
          queue.push(entry.target)
          continue
        }
        if (entry.type === 'file') yield { target: entry.target, path: joinDisplay(directory, entry) }
      }
    }
  }

  const dispatch = {
    async read(args, signal) {
      const target = await inside(args?.file_path, signal)
      const text = await readFile(target, signal)
      const lines = text.split(/\r?\n/)
      const offset = clampInteger(args?.offset, 1, 1, Math.max(1, lines.length))
      const limit = clampInteger(args?.limit, 2000, 1, 4000)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const body = slice.map((line, index) => `${offset + index}\t${line}`).join('\n')
      const suffix =
        offset - 1 + slice.length < lines.length
          ? `\n\n（共 ${lines.length} 行，已显示到第 ${offset - 1 + slice.length} 行）`
          : ''
      return body + suffix
    },

    async glob(args, signal) {
      const pattern = String(args?.pattern ?? '').trim()
      if (!pattern) throw new ReadOnlyToolError('glob 需要 pattern 参数。')
      const match = compileGlob(pattern)
      const base = await inside(args?.path, signal)
      const info = await fs.stat(base, signal)
      if (!info) throw new ReadOnlyToolError(`目录不存在：${base.displayPath}`)
      const found = []
      if (info.type === 'file') {
        if (match(relativeTo(root, base))) found.push(base.displayPath)
      } else {
        for await (const file of walk(base, signal)) {
          if (match(relativeTo(root, file.target))) {
            found.push(file.target.displayPath)
            if (found.length >= GLOB_RESULTS) break
          }
        }
      }
      if (found.length === 0) return '没有匹配的文件。'
      const capped = found.length >= GLOB_RESULTS ? `\n\n（结果已达上限 ${GLOB_RESULTS} 条）` : ''
      return `${found.join('\n')}${capped}`
    },

    async grep(args, signal) {
      const source = String(args?.pattern ?? '')
      if (!source) throw new ReadOnlyToolError('grep 需要 pattern 参数。')
      let regex
      try {
        regex = new RegExp(source, 'g')
      } catch (error) {
        throw new ReadOnlyToolError(`正则表达式无效：${error?.message ?? error}`)
      }
      const include = args?.include ? compileGlob(String(args.include)) : undefined
      const base = await inside(args?.path, signal)
      const info = await fs.stat(base, signal)
      if (!info) throw new ReadOnlyToolError(`路径不存在：${base.displayPath}`)

      const files = []
      if (info.type === 'file') files.push(base)
      else for await (const file of walk(base, signal)) files.push(file.target)

      const groups = []
      let matches = 0
      let scanned = 0
      for (const file of files) {
        if (signal?.aborted) break
        if (matches >= GREP_RESULTS || scanned > MAX_SCAN_BYTES) break
        const relative = relativeTo(root, file)
        if (include && !include(relative)) continue
        let text
        try {
          const stat = await fs.stat(file, signal)
          if (!stat || stat.type !== 'file') continue
          if (typeof stat.size === 'number' && stat.size > MAX_READ_BYTES) continue
          text = await fs.readText(file, signal)
        } catch {
          continue
        }
        scanned += text.length
        if (looksBinary(text)) continue
        const hits = []
        const lines = text.split(/\r?\n/)
        for (let index = 0; index < lines.length && matches < GREP_RESULTS; index += 1) {
          regex.lastIndex = 0
          if (!regex.test(lines[index])) continue
          matches += 1
          hits.push(`${index + 1}:${lines[index]}`)
        }
        if (hits.length > 0) groups.push(`${relative}\n${hits.join('\n')}`)
      }
      if (groups.length === 0) return '没有匹配。'
      const capped = matches >= GREP_RESULTS ? `\n\n（匹配数已达上限 ${GREP_RESULTS} 条）` : ''
      return `${groups.join('\n\n')}${capped}`
    },
  }

  return {
    schemas: READ_ONLY_TOOL_SCHEMAS,
    names: READ_ONLY_TOOL_NAMES,
    workspace: root.displayPath,

    /** Capability check used before dispatch; the same set governs both layers. */
    has(name) {
      return READ_ONLY_TOOL_NAMES.includes(name)
    },

    /**
     * Execute one model-proposed call. Unknown names are refused here, so a
     * fabricated tool name never reaches a handler even if a declaration leaked.
     *
     * @returns {Promise<{ text: string, isError: boolean }>} result for the model.
     */
    async execute(name, rawArguments, signal) {
      if (!READ_ONLY_TOOL_NAMES.includes(name)) {
        return {
          text: `该工具在临时会话中不可用。这里只开放只读的 ${READ_ONLY_TOOL_NAMES.join('、')}。`,
          isError: true,
          refused: true,
        }
      }
      let args = {}
      if (typeof rawArguments === 'string' && rawArguments.trim().length > 0) {
        try {
          args = JSON.parse(rawArguments)
        } catch {
          return { text: `工具参数不是合法 JSON：${name}`, isError: true }
        }
      }
      if (args === null || typeof args !== 'object') args = {}
      try {
        const text = await dispatch[name](args, signal)
        return { text, isError: false }
      } catch (error) {
        if (error instanceof ReadOnlyToolError) {
          return { text: error.message, isError: true, ...(error.refused ? { refused: true } : {}) }
        }
        return { text: `工具执行失败：${error?.message ?? error}`, isError: true }
      }
    },
  }
}

/* ------------------------------------------------------------------ helpers */

function clampInteger(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function looksBinary(text) {
  return text.slice(0, BINARY_SNIFF_BYTES).includes('\u0000')
}

function joinDisplay(directory, entry) {
  const base = directory.displayPath ?? ''
  return base.endsWith('/') ? `${base}${entry.name}` : `${base}/${entry.name}`
}

/** Workspace-relative path used for glob matching; falls back to the display path. */
function relativeTo(root, target) {
  const display = target.displayPath ?? ''
  const base = root.displayPath ?? ''
  if (base && display.startsWith(base)) {
    const rest = display.slice(base.length)
    return rest.startsWith('/') ? rest.slice(1) : rest
  }
  return display
}

/**
 * Compile one glob to a predicate. Supports `**`, `*`, `?` and `{a,b}`; a
 * pattern without `/` is matched against the basename at any depth.
 */
function compileGlob(pattern) {
  const normalized = pattern.replaceAll('\\', '/')
  const anchored = normalized.includes('/')
  const regex = new RegExp(`^${globToRegExpSource(normalized)}$`)
  return (relativePath) => {
    const candidate = relativePath.replaceAll('\\', '/')
    if (anchored) return regex.test(candidate)
    const base = candidate.slice(candidate.lastIndexOf('/') + 1)
    return regex.test(base) || regex.test(candidate)
  }
}

function globToRegExpSource(pattern) {
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      out += '[^/]'
      continue
    }
    if (char === '{') {
      const close = pattern.indexOf('}', index)
      if (close > index) {
        const alternatives = pattern.slice(index + 1, close).split(',')
        out += `(?:${alternatives.map((part) => globToRegExpSource(part)).join('|')})`
        index = close
        continue
      }
    }
    out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return out
}
