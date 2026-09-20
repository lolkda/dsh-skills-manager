import assert from 'node:assert/strict'
import test from 'node:test'
import { sessionFixture } from './helpers/session-harness.mjs'

// Regression target: selecting the first same-cwd agent instead of the requested session
// falsely reports native, externally added skills as missing. All snapshots below are real.
test('registry checks the requested session, not an older empty agent with the same cwd', async () => {
  const f = sessionFixture()
  try {
    const response = await f.request('GET', `/registry?sessionId=${f.active.id}&cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.ok, true)
    assert.equal(response.data.agentId, f.active.id)
    assert.deepEqual(response.data.skills.map(skill => skill.name).sort(), f.names)
    assert.ok(response.data.skills.every(skill => skill.provider === 'filesystem'))
    assert.equal(response.data.divergence.checked, true)
    assert.equal(response.data.divergence.consistent, true)
    assert.deepEqual(response.data.divergence.missing, [])
    assert.equal(response.data.divergence.overlaid, 0)
    assert.deepEqual(f.runtime.state.overrides, {})
  } finally { await f.cleanup() }
})

test('registry declines an ambiguous same-cwd comparison without a session id', async () => {
  const f = sessionFixture()
  try {
    const response = await f.request('GET', `/registry?cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.data.divergence.checked, false)
    assert.equal(response.data.agentId, null)
    assert.match(response.data.divergence.reason, /多个.*会话|会话.*不明确/)
  } finally { await f.cleanup() }
})

test('an unavailable requested session cannot silently fall back to another session', async () => {
  const f = sessionFixture()
  try {
    const response = await f.request('GET', `/registry?sessionId=session-gone&cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.data.divergence.checked, false)
    assert.equal(response.data.agentId, null)
    assert.match(response.data.divergence.reason, /指定会话/)
  } finally { await f.cleanup() }
})

test('a requested session in another cwd cannot borrow a matching old session', async () => {
  const f = sessionFixture()
  try {
    f.active.session.header.cwd = f.otherCwd
    const response = await f.request('GET', `/registry?sessionId=${f.active.id}&cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.data.divergence.checked, false)
    assert.equal(response.data.agentId, null)
  } finally { await f.cleanup() }
})

test('a requested session with unknown cwd cannot borrow a matching old session', async () => {
  const f = sessionFixture()
  try {
    delete f.active.session.header.cwd
    const response = await f.request('GET', `/registry?sessionId=${f.active.id}&cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.data.divergence.checked, false)
    assert.equal(response.data.agentId, null)
  } finally { await f.cleanup() }
})

test('the requested session determines catalog cwd when the request omits cwd', async () => {
  const f = sessionFixture()
  try {
    f.active.session.header.cwd = f.otherCwd
    const response = await f.request('GET', `/catalog?sessionId=${f.active.id}`)
    assert.equal(response.ok, true)
    assert.equal(response.data.cwd, f.otherCwd)
  } finally { await f.cleanup() }
})

test('the requested session determines registry cwd when the request omits cwd', async () => {
  const f = sessionFixture()
  try {
    f.active.session.header.cwd = f.otherCwd
    const response = await f.request('GET', `/registry?sessionId=${f.active.id}`)
    assert.equal(response.data.cwd, f.otherCwd)
    assert.equal(response.data.agentId, f.active.id)
    assert.equal(response.data.divergence.consistent, true)
  } finally { await f.cleanup() }
})

test('an explicitly selected empty session still reports a real difference', async () => {
  const f = sessionFixture()
  try {
    const response = await f.request('GET', `/registry?sessionId=${f.inactive.id}&cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.data.agentId, f.inactive.id)
    assert.equal(response.data.divergence.checked, true)
    assert.equal(response.data.divergence.consistent, false)
    assert.deepEqual(response.data.divergence.missing, f.names)
  } finally { await f.cleanup() }
})

test('a single matching session remains a valid legacy comparison without sessionId', async () => {
  const f = sessionFixture()
  try {
    f.agents.shift()
    const response = await f.request('GET', `/registry?cwd=${encodeURIComponent(f.cwd)}`)
    assert.equal(response.data.agentId, f.active.id)
    assert.equal(response.data.divergence.consistent, true)
  } finally { await f.cleanup() }
})
