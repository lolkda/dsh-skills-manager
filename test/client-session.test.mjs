import assert from 'node:assert/strict'
import test from 'node:test'
import { findFirst, loadClient, textOf } from './helpers/client-harness.mjs'
import { sessionFixture } from './helpers/session-harness.mjs'

const notice = (tree, tone) => findFirst(tree, node => node.props?.className === `dshsm-notice dshsm-notice--${tone}`)

function clientFixture(f, options = {}) {
  let selected = f.active.id
  const calls = []
  const slotProps = {
    // Same public selector contract as DSH's global useSessions slot prop.
    useSessions: selector => selector({
      phase: 'ready',
      byId: Object.fromEntries(f.agents.map(agent => [agent.id, {
        id: agent.id,
        cwd: agent.session.header.cwd,
        retainedBy: agent.id === selected ? { mainView: 1 } : {},
      }])),
    }),
  }
  const fetch = async (url, init = {}) => {
    calls.push(url)
    const parsed = new URL(url, 'http://test')
    if (options.beforeRequest) await options.beforeRequest(parsed)
    if (options.registrySession && parsed.pathname.endsWith('/registry')) {
      parsed.searchParams.set('sessionId', options.registrySession)
    }
    const response = await f.request(init.method ?? 'GET', parsed.pathname.replace('/dsh-skills-manager', '') + parsed.search,
      init.body ? JSON.parse(init.body) : undefined)
    return { status: response.statusCode, json: async () => response }
  }
  return {
    client: loadClient({ fetch, slotProps }),
    calls,
    select(id) { selected = id },
  }
}

test('settings checks externally added skills against the selected GUI session', async () => {
  const f = sessionFixture()
  try {
    const { client, calls } = clientFixture(f)
    const tree = await client.mount()
    assert.match(textOf(notice(tree, 'ok')), /2 条一致/)
    assert.equal(notice(tree, 'danger'), undefined)
    for (const name of f.names) assert.match(textOf(tree), new RegExp(name))
    const query = new URL(calls.find(url => url.includes('/registry')), 'http://test').searchParams
    assert.equal(query.get('sessionId'), f.active.id)
    assert.equal(query.get('cwd'), f.cwd)
  } finally { await f.cleanup() }
})

test('settings starts in the selected session cwd rather than the first host session cwd', async () => {
  const f = sessionFixture()
  try {
    f.active.session.header.cwd = f.otherCwd
    const { client, calls } = clientFixture(f)
    const tree = await client.mount()
    const firstCatalog = new URL(calls.find(url => url.includes('/catalog')), 'http://test')
    assert.equal(firstCatalog.searchParams.get('cwd'), f.otherCwd)
    assert.match(textOf(notice(tree, 'ok')), /2 条一致/)
  } finally { await f.cleanup() }
})

test('switching GUI sessions with the same cwd refreshes the registry identity', async () => {
  const f = sessionFixture()
  try {
    const c = clientFixture(f)
    c.select(f.inactive.id)
    const before = await c.client.mount()
    assert.ok(notice(before, 'danger'), 'the explicitly selected empty session really lacks the files')
    c.select(f.active.id)
    const after = await c.client.update()
    assert.match(textOf(notice(after, 'ok')), /2 条一致/)
    assert.equal(notice(after, 'danger'), undefined)
    const last = c.calls.filter(url => url.includes('/registry')).at(-1)
    assert.equal(new URL(last, 'http://test').searchParams.get('sessionId'), f.active.id)
  } finally { await f.cleanup() }
})

test('a delayed response from another same-cwd session cannot restore its red warning', async () => {
  const f = sessionFixture()
  const gate = Promise.withResolvers()
  const c = clientFixture(f, {
    beforeRequest: async url => {
      if (url.searchParams.get('sessionId') === f.inactive.id) await gate.promise
    },
  })
  try {
    await c.client.mount()
    c.select(f.inactive.id)
    await c.client.update()
    c.select(f.active.id)
    const current = await c.client.update()
    assert.match(textOf(notice(current, 'ok')), /2 条一致/)
    gate.resolve()
    const after = await c.client.update()
    assert.match(textOf(notice(after, 'ok')), /2 条一致/)
    assert.equal(notice(after, 'danger'), undefined)
  } finally {
    gate.resolve()
    await c.client.flush()
    await f.cleanup()
  }
})

test('without a selected GUI session, settings does not claim to have checked the model', async () => {
  const f = sessionFixture()
  try {
    f.agents.shift()
    const c = clientFixture(f)
    c.select(null)
    const tree = await c.client.mount()
    assert.equal(notice(tree, 'ok'), undefined)
    assert.equal(notice(tree, 'danger'), undefined)
    assert.match(textOf(tree), /尚无当前会话的注册表观测/)
    assert.equal(c.calls.some(url => url.includes('/registry')), false)
  } finally { await f.cleanup() }
})

test('settings rejects a registry response for a different session, including an older backend', async () => {
  const f = sessionFixture()
  try {
    const { client } = clientFixture(f, { registrySession: f.inactive.id })
    const tree = await client.mount()
    assert.equal(notice(tree, 'danger'), undefined)
    assert.equal(notice(tree, 'ok'), undefined)
    assert.match(textOf(tree), /尚无当前会话的注册表观测/)
  } finally { await f.cleanup() }
})
