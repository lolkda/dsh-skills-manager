/** Two real agent scopes sharing one cwd: an old empty view and a current native filesystem view. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { createRuntime } from '../../lib/index.js'
import { installRoutes } from '../../lib/routes.js'
import { call } from './host-harness.mjs'

export function sessionFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dshsm-session-'))
  const cwd = join(dir, 'project')
  const otherCwd = join(dir, 'other-project')
  const home = join(dir, 'home')
  const settings = { dshHome: home, agentsHome: join(dir, 'agents'), log: false, watch: false }
  for (const path of [cwd, otherCwd]) mkdirSync(path, { recursive: true })
  // These skills are deliberately added outside the manager: no policy overrides or imports.
  const names = ['outside-a', 'outside-b']
  for (const name of names) {
    const path = join(home, 'skills', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: External skill\n---\nBody\n`)
  }
  const root = new Context()
  const registry = new SkillRegistry(root)
  const oldScope = createScope(root, {})
  const currentScope = createScope(root, {})
  let provider
  const stopNative = currentScope.ctx.skills.registerProvider(control => {
    provider = new FileSystemSkillProvider(currentScope.ctx, control, settings)
    return provider
  })
  const inactive = { id: 'session-old', ctx: oldScope.ctx, session: { header: { cwd } } }
  const active = { id: 'session-current', ctx: currentScope.ctx, session: { header: { cwd } } }
  const agents = [inactive, active]
  const runtime = createRuntime(settings)
  runtime.setDefaultCwd(cwd)
  runtime.registry = registry
  let route
  const ctx = {
    get(name) {
      if (name === 'webRuntime') return { trustedHosts: [] }
      if (name === 'agents') return { list: () => agents }
      if (name === 'sessions') return { list: () => agents.map(agent => agent.session) }
    },
  }
  installRoutes(ctx, { register(spec) { route = spec; return () => {} } }, runtime)
  return {
    cwd, otherCwd, home, names, runtime, agents, active, inactive, currentScope,
    request: (method, path, body) => call(route, method, `/dsh-skills-manager${path}`, body),
    async cleanup() {
      try {
        stopNative()
        await provider.dispose()
        await currentScope.dispose()
        await oldScope.dispose()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  }
}
