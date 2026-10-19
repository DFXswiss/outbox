import type { AlertSink } from './alerts'
import { contentHash } from './content-hash'
import type { SqliteDatabase } from './db'
import {
  claimNextDue,
  finishPost,
  markInterruptedOnBoot,
  type ClaimedPost
} from './queue'
import type { PublishResult } from './status'

export type PublisherDeps = {
  db: SqliteDatabase
  x: {
    probe(): Promise<'ok' | 'bad'>
    postTweet(
      text: string,
      deadlineMs: number
    ): Promise<{ result: PublishResult; needsLogin: boolean }>
  }
  alert: AlertSink
  log: (line: string) => void
  now?: () => number
  intervalMs?: number
  budgetMs?: number
  reprobeMs?: number
}

export function createPublisher(deps: PublisherDeps) {
  const now = deps.now ?? (() => Date.now())
  const intervalMs = deps.intervalMs ?? 15_000
  const budgetMs = deps.budgetMs ?? 90_000
  const reprobeMs = deps.reprobeMs ?? 300_000
  let active = false
  let state: 'ok' | 'bad' = 'bad'
  let lastProbeAt = Number.NEGATIVE_INFINITY
  let interval: ReturnType<typeof setInterval> | null = null
  let tickFlight: Promise<void> | null = null
  let startFlight: Promise<void> | null = null

  function logFailure(line: string): void {
    try {
      deps.log(line)
    } catch {
      return
    }
  }

  async function runProbe(): Promise<'ok' | 'bad'> {
    lastProbeAt = now()
    try {
      state = await deps.x.probe()
    } catch {
      state = 'bad'
    }
    return state
  }

  async function tick(): Promise<void> {
    if (!active || tickFlight) {
      return
    }

    const run = async () => {
      let post: ClaimedPost | null
      try {
        if (state !== 'ok') {
          const probeState = now() - lastProbeAt >= reprobeMs
            ? await runProbe()
            : state
          if (probeState !== 'ok') {
            return
          }
        }
        post = claimNextDue(deps.db, now())
      } catch {
        logFailure('Publisher tick failed before claim')
        return
      }

      if (!post) {
        return
      }

      try {
        let result: PublishResult
        let needsLogin = false
        if (post.imageSha256 !== null) {
          result = {
            channel: 'x',
            ok: false,
            error: 'image posts are not supported yet'
          }
        } else if (
          contentHash(post.text, post.scheduledAt, null) !== post.contentHash
        ) {
          result = {
            channel: 'x',
            ok: false,
            error: 'content changed after approval'
          }
        } else {
          const published = await deps.x.postTweet(
            post.text,
            now() + budgetMs
          )
          result = published.result
          needsLogin = published.needsLogin
        }

        const finished = finishPost(deps.db, {
          postId: post.postId,
          result,
          now: now()
        })
        if (!finished.ok) {
          throw new Error('publish result could not be recorded')
        }
        if (finished.status === 'failed' || finished.status === 'uncertain') {
          deps.alert({
            kind: finished.status,
            postId: post.postId,
            detail: result.error ?? finished.status
          })
        }
        if (needsLogin) {
          deps.alert({
            kind: 'needs-login',
            postId: post.postId,
            detail: result.error ?? 'X login required'
          })
          state = 'bad'
          lastProbeAt = now()
        }
      } catch {
        const detail = 'unexpected publisher failure'
        try {
          const finished = finishPost(deps.db, {
            postId: post.postId,
            result: {
              channel: 'x',
              ok: false,
              uncertain: true,
              error: detail
            },
            now: now()
          })
          deps.alert({
            kind: 'uncertain',
            postId: post.postId,
            detail: finished.ok ? detail : 'could not record publish outcome'
          })
        } catch {
          deps.alert({
            kind: 'uncertain',
            postId: post.postId,
            detail: 'could not record publish outcome'
          })
        }
      }
    }

    tickFlight = run()
    try {
      await tickFlight
    } catch {
      logFailure('Publisher tick failed')
    } finally {
      tickFlight = null
    }
  }

  async function start(): Promise<void> {
    if (active) {
      if (startFlight) {
        await startFlight
      }
      return
    }
    active = true
    const flight = (async () => {
      for (const postId of markInterruptedOnBoot(deps.db, now())) {
        deps.alert({
          kind: 'interrupted',
          postId,
          detail: 'interrupted by restart'
        })
      }
      await runProbe()
      if (!active) {
        return
      }
      interval = setInterval(() => {
        void tick()
      }, intervalMs)
    })()
    startFlight = flight
    try {
      await flight
    } finally {
      if (startFlight === flight) {
        startFlight = null
      }
    }
  }

  async function stop(): Promise<void> {
    active = false
    if (interval) {
      clearInterval(interval)
    }
    interval = null
    if (startFlight) {
      await startFlight
    }
    if (tickFlight) {
      await tickFlight
    }
  }

  return {
    start,
    stop,
    running: () => active,
    probeState: () => state,
    tick
  }
}
