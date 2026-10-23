import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('manifest does not gate the host on a DSH version', () => {
  const dshPeers = Object.entries(pkg.peerDependencies ?? {})
    .filter(([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))

  assert.deepEqual(
    dshPeers.map(([name]) => name).sort(),
    ['@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-skill'],
  )
  for (const [name, range] of dshPeers) {
    assert.equal(range, '*', `${name} must not gate the runtime version`)
  }
  assert.equal(pkg.dsh?.compatibility?.dsh, '*', 'the marketplace range must not gate the runtime version')
  assert.equal(pkg.engines?.dsh, undefined, 'engines.dsh must not reintroduce a runtime gate')
})
