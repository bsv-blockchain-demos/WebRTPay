/**
 * Ruling 11: the root entry runs in browsers and React Native, so nothing under `src/` may
 * use Node: no `node:*` or other Node builtin module, no `ws` or `node-datachannel` (those
 * belong to `server/` and the tests), no `Buffer`, no `process`. Its only package import
 * is the `@bsv/sdk` peer dependency.
 */
import { describe, expect, it } from '@jest/globals'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')

/** Packages the root entry may import: its peer dependency. */
const ALLOWED_PACKAGES = ['@bsv/sdk']
/** Node-only packages of this repository. */
const NODE_PACKAGES = ['ws', 'node-datachannel']

/** Specifiers in `import … from`, `export … from`, `import '…'`, `import('…')`, `require('…')`. */
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*(['"])([^'"\n]+)\1/g

/** Every way `source` (TypeScript text) depends on Node, one message each. */
function nodeDependencies(source: string): string[] {
  const problems: string[] = []
  for (const [, , specifier] of source.matchAll(SPECIFIER)) {
    const bare = specifier.split('/')[0]
    const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : bare
    if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
      problems.push(`imports the Node builtin '${specifier}'`)
    } else if (NODE_PACKAGES.includes(pkg)) {
      problems.push(`imports the Node-only package '${specifier}'`)
    } else if (!specifier.startsWith('.') && !ALLOWED_PACKAGES.includes(pkg)) {
      problems.push(`imports '${specifier}', which is not a dependency of the root entry`)
    }
  }
  if (/\bBuffer\b/.test(source)) problems.push('uses Buffer')
  if (/\bprocess\.[A-Za-z_$]/.test(source)) problems.push('uses process')
  return problems
}

function typeScriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return typeScriptFiles(path)
    return path.endsWith('.ts') ? [path] : []
  })
}

describe('browser safety of src/ (Ruling 11)', () => {
  it('flags Node builtins, Node-only packages, Buffer, process and unknown packages', () => {
    expect(nodeDependencies("import { readFileSync } from 'node:fs'")).toEqual([
      "imports the Node builtin 'node:fs'"
    ])
    expect(nodeDependencies("import { randomBytes } from 'crypto'")).toEqual([
      "imports the Node builtin 'crypto'"
    ])
    expect(nodeDependencies("const p = await import('fs/promises')")).toEqual([
      "imports the Node builtin 'fs/promises'"
    ])
    expect(nodeDependencies("import WebSocket from 'ws'")).toEqual([
      "imports the Node-only package 'ws'"
    ])
    expect(nodeDependencies("export * from 'node-datachannel/polyfill'")).toEqual([
      "imports the Node-only package 'node-datachannel/polyfill'"
    ])
    expect(nodeDependencies("const qr = require('qrcode')")).toEqual([
      "imports 'qrcode', which is not a dependency of the root entry"
    ])
    expect(nodeDependencies('const b = Buffer.from(bytes)')).toEqual(['uses Buffer'])
    expect(nodeDependencies('if (process.env.DEBUG) log()')).toEqual(['uses process'])
    expect(
      nodeDependencies(
        [
          "import { PublicKey } from '@bsv/sdk'",
          "import type { WalletProtocol } from '@bsv/sdk'",
          "export * from './codec/codes.js'",
          "import { toHex } from '../util/bytes.js'",
          'const view = new Uint8Array(new ArrayBuffer(8))',
          '// one step in the process. Then the next'
        ].join('\n')
      )
    ).toEqual([])
  })

  it('finds none of them in any file under src/', () => {
    const files = typeScriptFiles(SRC)
    expect(files.length).toBeGreaterThan(20)
    const problems = files.flatMap(file =>
      nodeDependencies(readFileSync(file, 'utf8')).map(p => `${relative(ROOT, file)} ${p}`)
    )
    expect(problems).toEqual([])
  })
})
