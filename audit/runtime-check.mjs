/** Read-only evidence capture against an existing DSH web instance. */
const base = process.argv[2] ?? 'http://127.0.0.1:3080'
const cwd = process.argv[3] ?? process.cwd()
const evidence = { capturedAt: new Date().toISOString(), base, requestedCwd: cwd, auth: {}, catalog: null, registry: null }
for (const path of ['/', '/api']) {
  const response = await fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(15000) })
  evidence.auth[path] = { status: response.status }
  await response.body?.cancel()
}
for (const endpoint of ['catalog', 'registry']) {
  const url = new URL(`/dsh-skills-manager/${endpoint}`, base)
  url.searchParams.set('cwd', cwd)
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) })
  const payload = await response.json()
  if (!payload.ok) throw new Error(`${endpoint}: HTTP ${response.status}: ${payload.error}`)
  const data = payload.data
  evidence[endpoint] = {
    status: response.status,
    cwd: data.cwd,
    scope: data.scope,
    complete: data.complete,
    roots: data.roots?.map(({ key, source, path, exists, skills }) => ({ key, source, path, exists, count: skills.length })),
    skills: data.skills.map(({ name, rootKey, source, provider, modelInvocable, userInvocable, enabled, winner, loadable }) => ({ name, rootKey, source, provider, modelInvocable, userInvocable, enabled, winner, loadable })),
    divergence: data.divergence,
  }
}
console.log(JSON.stringify(evidence, null, 2))
