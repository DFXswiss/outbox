type JsonRequest = (path: string) => Promise<unknown>

export async function cleanupTweetsAfterStop(
  stop: () => Promise<void>,
  read: () => Promise<Array<{ id: string; text: string }>>,
  remove: (id: string) => Promise<void>,
  knownIds: Iterable<string>
): Promise<void> {
  await stop()
  await cleanupTimelinePosts(read, remove, knownIds)
}

/** Finds all run posts, following pagination so an older post cannot be missed. */
export async function findTimelinePosts(request: JsonRequest, runId: string): Promise<Array<{ id: string; text: string }>> {
  if (!runId) throw new Error('Run ID is required')
  const me = await request('/2/users/me') as { data?: { id?: unknown }; errors?: unknown }
  if (me.errors || typeof me.data?.id !== 'string' || !/^\d+$/.test(me.data.id)) throw new Error('X account lookup failed')
  const found: Array<{ id: string; text: string }> = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (;;) {
    const query = new URLSearchParams({ max_results: '20' })
    if (cursor) query.set('pagination_token', cursor)
    const response = await request(`/2/users/${me.data.id}/tweets?${query}`) as { data?: unknown; meta?: { result_count?: unknown; next_token?: unknown }; errors?: unknown }
    if (response.errors || !response.meta || typeof response.meta.result_count !== 'number' || !Number.isInteger(response.meta.result_count) || response.meta.result_count < 0) throw new Error('Invalid X timeline response')
    if (response.data === undefined && response.meta.result_count === 0) {
      // X omits data for an empty result.
    } else {
      if (!Array.isArray(response.data) || response.data.length !== response.meta.result_count) throw new Error('Invalid X timeline response')
      for (const item of response.data) {
        if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !/^\d+$/.test(item.id) || typeof item.text !== 'string') throw new Error('Invalid X timeline post')
        if (item.text.includes(runId)) found.push({ id: item.id, text: item.text })
      }
    }
    const next = response.meta.next_token
    if (next === undefined) return found
    if (typeof next !== 'string' || !next || seen.has(next) || seen.size >= 100) throw new Error('Invalid X timeline pagination')
    seen.add(next)
    cursor = next
  }
}

/** Attempts every known deletion and only succeeds after an empty verification read. */
export async function cleanupTimelinePosts(
  read: () => Promise<Array<{ id: string; text: string }>>,
  remove: (id: string) => Promise<void>,
  knownIds: Iterable<string>
): Promise<void> {
  let failed = false
  const ids = new Set(knownIds)
  try { for (const post of await read()) ids.add(post.id) } catch { failed = true }
  for (const id of ids) {
    try { await remove(id) } catch { failed = true }
  }
  try { if ((await read()).length > 0) failed = true } catch { failed = true }
  if (failed) throw new Error('X timeline cleanup failed')
}
