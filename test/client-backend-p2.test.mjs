import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { boot } from './helpers/host-harness.mjs'
import { findFirst, loadClient, textOf } from './helpers/client-harness.mjs'

function bridge(env) {
  return async (url, init = {}) => {
    const result = await env.request(init.method ?? 'GET', url, init.body ? JSON.parse(init.body) : undefined)
    return { status: result.statusCode, json: async () => result }
  }
}
const button = (tree, label) => findFirst(tree, node => node.type === 'button' && textOf(node).trim().endsWith(label))
const row = tree => findFirst(tree, node => node.props?.className === 'dshsm-row__main' && textOf(node).includes('repair-me'))
const broken = '---\nname: repair-me\n---\nBody\n'
const repaired = '---\nname: repair-me\ndescription: Repaired through UI\n---\nBody\n'

for (const operation of ['repair', 'delete']) {
  test(`P2 全链路：损坏技能通过界面 ${operation} 走真实路由与磁盘`, async () => {
    const env = await boot()
    try {
      const dir = join(env.home, 'skills', 'repair-me')
      mkdirSync(dir)
      const path = join(dir, 'SKILL.md')
      writeFileSync(path, broken, 'utf8')
      const client = loadClient({ fetch: bridge(env) })
      let tree = await client.mount()
      assert.ok(row(tree))
      row(tree).props.onClick(); tree = await client.update()
      if (operation === 'repair') {
        assert.ok(button(tree, '编辑正文'))
        await button(tree, '编辑正文').props.onClick(); tree = await client.update()
        const input = findFirst(tree, node => node.type === 'textarea')
        assert.ok(input, 'real content route must allow reading the broken document')
        assert.equal(input.props.value, broken)
        input.props.onChange({ target: { value: repaired } }); tree = await client.update()
        await button(tree, '保存').props.onClick(); tree = await client.update()
        assert.equal(readFileSync(path, 'utf8'), repaired)
        const latest = await env.request('GET', '/dsh-skills-manager/catalog')
        assert.equal(latest.data.skills.find(skill => skill.name === 'repair-me').winner, true)
      } else {
        button(tree, '删除').props.onClick(); tree = await client.update()
        assert.equal(existsSync(path), true, 'first click only requests confirmation')
        await button(tree, '确认删除').props.onClick(); tree = await client.update()
        assert.equal(existsSync(dir), false)
        assert.equal(row(tree), undefined)
      }
    } finally { env.cleanup() }
  })
}
