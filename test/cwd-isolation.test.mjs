/**
 * 启停覆盖的作用域：**项目级按项目隔离，用户级共享**。
 *
 * 用户问过一句「切换工作目录后，是不是可以各自配置技能的启停」。答案取决于覆盖的键，
 * 所以这里把它钉死：键里带项目标识，因此两个项目各自的同名技能互不影响；
 * 而用户根（`~/.dsh/skills`）在两个项目里是**同一个目录**，共享才是对的。
 *
 * 这个不变量有个很容易踩的退化方式：如果把键写成固定的 `project-dsh`，
 * 那么 A 项目里停用一个技能，B 项目里同名的技能会**跟着被停用**，而界面上看不出任何异常 ——
 * 正是这个插件最该避免的那类"说技能在生效 / 不在生效，而事实相反"的错。
 *
 * 顺带钉住一个驱动层的事实：路由的 cwd **只从 URL query 取**，请求体里的 `cwd` 不作数
 * （客户端每次请求都带 `?cwd=`）。少了它，`project-dsh@<项目>` 这个键根本不在候选里，
 * 写入会静默失败成 `root.unknown` —— 写这条测试时我就先踩了一次。
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync } from 'node:fs'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { boot, call } from './helpers/host-harness.mjs'

const NL = String.fromCharCode(10)

/**
 * 造一个项目：带 `.git`，并且 `.dsh/skills` 下放一个 `shared-name` 技能。
 * @param {string} parent - 父目录
 * @param {string} label - 项目名
 * @returns {string} 项目根
 */
function makeProject(parent, label) {
  const root = join(parent, label)
  mkdirSync(join(root, '.git'), { recursive: true })
  const dir = join(root, '.dsh', 'skills', 'shared-name')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), ['---', 'name: shared-name', `description: ${label} 里的同名技能`, '---', '正文', ''].join(NL), 'utf8')
  return root
}

test('项目级启停按项目隔离，用户级共享', async () => {
  const env = await boot()
  try {
    const route = env.routes.find((r) => r.path === '/dsh-skills-manager')
    const A = makeProject(env.dir, 'proj-a')
    const B = makeProject(env.dir, 'proj-b')

    const catalogOf = async (cwd) => (await call(route, 'GET', `/dsh-skills-manager/catalog?cwd=${encodeURIComponent(cwd)}`)).data
    const skillOf = async (cwd, name) => (await catalogOf(cwd)).skills.find((s) => s.name === name)
    const policy = (cwd, rootKey, name, enabled) =>
      call(route, 'POST', `/dsh-skills-manager/policy?cwd=${encodeURIComponent(cwd)}`, { rootKey, name, enabled, cwd })

    const rootOf = async (cwd, source) => (await catalogOf(cwd)).roots.find((r) => r.source === source)

    // 1) 两个项目各自算出一个**带项目标识**的键 —— 这是隔离的前提。
    const rootA = await rootOf(A, 'project-dsh')
    const rootB = await rootOf(B, 'project-dsh')
    assert.match(rootA.key, /^project-dsh@/, `项目根的键必须带项目标识，实际是 ${rootA.key}`)
    assert.notEqual(rootA.key, rootB.key, '两个项目的键不能相同，否则覆盖会串台')
    assert.equal(rootA.path.toLowerCase().includes('proj-a'), true)

    // 2) 在 A 里停用，B 里必须不受影响。
    assert.equal((await skillOf(A, 'shared-name')).effectiveModelInvocable, true, '前提：A 里默认是启用的')
    const disabled = await policy(A, rootA.key, 'shared-name', false)
    assert.equal(disabled.ok, true, disabled.ok ? '' : `写入失败：${disabled.code} ${disabled.error}`)

    assert.equal((await skillOf(A, 'shared-name')).effectiveModelInvocable, false, 'A 里应当已停用')
    assert.equal((await skillOf(B, 'shared-name')).effectiveModelInvocable, true, 'B 里的同名技能**绝不能**跟着被停用')

    // 3) 落盘的键也要带项目标识，否则重启后照样串台。
    const state = JSON.parse(readFileSync(join(env.dir, '.dsh', 'dsh-skills-manager', 'state.json'), 'utf8'))
    assert.deepEqual(Object.keys(state.overrides), [rootA.key], 'state.json 里的键应当是带项目标识的那个')

    // 4) 用户根在两个项目里是同一个目录，所以共享才是对的。
    const userKey = (await rootOf(A, 'user-dsh')).key
    assert.equal(userKey, (await rootOf(B, 'user-dsh')).key, '用户根与工作目录无关，键必须相同')
    await policy(A, userKey, 'plain', false)
    assert.equal((await skillOf(B, 'plain')).effectiveModelInvocable, false, '用户根是同一个目录，停用当然要共享')
  } finally {
    env.cleanup()
  }
})

test('不带 ?cwd= 时，项目根的键不在候选里 —— 写入必须失败而不是写错地方', async () => {
  // 这条是上一条的驱动层教训：cwd 只在 query 里。少了它，服务端算的是**它自己**的
  // 项目根，拿另一个项目的键去写就会落进 `root.unknown`。宁可失败，也不能默默写到别的项目头上。
  const env = await boot()
  try {
    const route = env.routes.find((r) => r.path === '/dsh-skills-manager')
    const A = makeProject(env.dir, 'proj-a')
    const rootA = (await call(route, 'GET', `/dsh-skills-manager/catalog?cwd=${encodeURIComponent(A)}`)).data.roots.find((r) => r.source === 'project-dsh')

    const noCwd = await call(route, 'POST', '/dsh-skills-manager/policy', { rootKey: rootA.key, name: 'shared-name', enabled: false })
    assert.equal(noCwd.ok, false, '没有 cwd 时不该悄悄成功')
    assert.equal(noCwd.code, 'root.unknown')
  } finally {
    env.cleanup()
  }
})
