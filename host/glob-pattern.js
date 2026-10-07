/**
 * Compile one glob to a predicate. Supports `**`, `*`, `?` and `{a,b}`; a
 * pattern without `/` is matched against the basename at any depth.
 */
export function compileGlob(pattern) {
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
