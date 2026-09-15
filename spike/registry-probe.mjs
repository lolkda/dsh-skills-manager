/**
 * Offline probe for the real `ctx.skills` registry semantics.
 *
 * Boots the *actual* published packages — `@deepseek-ai/dsh-skill` (registry)
 * and `@deepseek-ai/dsh-skill-filesystem` (local provider) — plus a throwaway
 * overlay provider that mimics what our plugin intends to do for enable/disable.
 *
 * Goal: prove (or disprove) that a third-party provider wins a duplicate skill
 * name by rank, so that enable/disable can be implemented without touching the
 * skill's source file.
 *
 * Run: node spike/registry-probe.mjs
 */

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

const HOME = process.env.USERPROFILE || process.env.HOME
const DSH_HOME = `${HOME}\\.dsh`
const AGENTS_HOME = `${HOME}\\.agents`

/** A workspace that exists, so project-root resolution does not blow up. */
const CWD = process.cwd()

const TARGET = 'test-driven-development'

function overlayPlugin(rank) {
  return {
    name: `probe-overlay-rank-${rank}`,
    inject: ['skills'],
    apply(ctx) {
      ctx.skills.registerProvider(() => ({
        name: `probe-overlay-rank-${rank}`,
        list: async () => [
          {
            name: TARGET,
            description: 'PROBE OVERLAY — should win over the filesystem provider',
            invocation: { modelInvocable: false, userInvocable: false },
            source: 'user-dsh',
            provider: `probe-overlay-rank-${rank}`,
            rank,
            locator: { probe: true },
          },
        ],
        get: async () => undefined,
      }))
    },
  }
}

async function boot({ withFilesystem, withOverlayRank }) {
  const ctx = new Context()
  ctx.plugin(SkillRegistry, {})
  if (withFilesystem) {
    ctx.plugin(skillFilesystem, { dshHome: DSH_HOME, agentsHome: AGENTS_HOME, watch: false })
  }
  if (withOverlayRank !== undefined) {
    ctx.plugin(overlayPlugin(withOverlayRank))
  }
  return ctx
}

async function snapshot(ctx) {
  const snap = await ctx.skills.snapshot({ cwd: CWD })
  return snap
}

function render(snap) {
  return snap.skills
    .map((s) => `${s.name}\tmodel=${s.invocation.modelInvocable}\tuser=${s.invocation.userInvocable}\tprovider=${s.provider}\tsource=${s.source}`)
    .join('\n')
}

async function scenario(label, options) {
  console.log(`\n================ ${label} ================`)
  let ctx
  try {
    ctx = await boot(options)
    // cordis needs one microtask turn for plugin fibers to settle.
    await new Promise((r) => setTimeout(r, 250))
    const snap = await snapshot(ctx)
    console.log(`complete=${snap.complete} total=${snap.skills.length}`)
    console.log(render(snap))
    const winner = snap.skills.find((s) => s.name === TARGET)
    console.log(
      `>>> ${TARGET} winner: ${winner ? `${winner.provider} model=${winner.invocation.modelInvocable}` : 'NOT PRESENT'}`,
    )
  } catch (error) {
    console.log(`!! scenario failed: ${error && error.stack ? error.stack : error}`)
  } finally {
    try {
      if (ctx) await ctx.stop()
    } catch {}
  }
}

await scenario('S1 baseline: filesystem provider only', { withFilesystem: true })
await scenario('S2 overlay rank=0 (below every filesystem rank)', { withFilesystem: true, withOverlayRank: 0 })
await scenario('S3 overlay rank=399 (just below user-dsh rank 400)', { withFilesystem: true, withOverlayRank: 399 })

process.exit(0)
