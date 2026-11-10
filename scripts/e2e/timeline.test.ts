import { describe, expect, it } from 'vitest'
import { cleanupTimelinePosts, findTimelinePosts } from './timeline'

describe('E2E timeline cleanup', () => {
  it('finds run posts on subsequent timeline pages and ignores other posts', async () => {
    const paths: string[] = []
    const found = await findTimelinePosts(async (path) => {
      paths.push(path)
      // Shapes: https://docs.x.com/x-api/users/get-my-user and https://docs.x.com/x-api/users/get-posts
      if (path === '/2/users/me') return { data: { id: '123', name: 'Test', username: 'test' } }
      if (path.includes('pagination_token=')) return { data: [{ id: '2', text: 'Outbox E2E run-id response loss' }], meta: { result_count: 1 } }
      return { data: [{ id: '1', text: 'Unrelated post' }], meta: { result_count: 1, next_token: 'next-page' } }
    }, 'run-id')
    expect(found).toEqual([{ id: '2', text: 'Outbox E2E run-id response loss' }])
    expect(paths).toEqual(['/2/users/me', '/2/users/123/tweets?max_results=20', '/2/users/123/tweets?max_results=20&pagination_token=next-page'])
  })

  it('deletes timeline-discovered posts and known IDs, then checks the timeline again', async () => {
    let reads = 0
    const removed: string[] = []
    await cleanupTimelinePosts(async () => {
      reads += 1
      return reads === 1 ? [{ id: '2', text: 'run-id' }] : []
    }, async (id) => { removed.push(id) }, ['1'])
    expect(removed).toEqual(['1', '2'])
    expect(reads).toBe(2)
  })

  it('fails if a post remains after deletion or a timeline read fails', async () => {
    const post = { id: '2', text: 'run-id' }
    await expect(cleanupTimelinePosts(async () => [post], async () => {}, [])).rejects.toThrow('cleanup failed')
    const removed: string[] = []
    await expect(cleanupTimelinePosts(async () => { throw new Error('unavailable') }, async (id) => { removed.push(id) }, ['1'])).rejects.toThrow('cleanup failed')
    expect(removed).toEqual(['1'])
  })

  it('attempts remaining deletions but fails if any delete failed', async () => {
    const attempts: string[] = []
    await expect(cleanupTimelinePosts(async () => [], async (id) => {
      attempts.push(id)
      if (id === '1') throw new Error('delete failed')
    }, ['1', '2'])).rejects.toThrow('cleanup failed')
    expect(attempts).toEqual(['1', '2'])
  })

  it('does not treat an invalid timeline response as empty', async () => {
    // Shapes: https://docs.x.com/x-api/users/get-my-user and https://docs.x.com/x-api/users/get-posts
    const request = async (path: string) => path === '/2/users/me' ? { data: { id: '123', username: 'test' } } : { meta: { result_count: 1 } }
    await expect(findTimelinePosts(request, 'run-id')).rejects.toThrow('Invalid X timeline response')
  })
})
