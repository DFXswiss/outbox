import type { createLog } from './log'

export type Alert = {
  kind: 'failed' | 'uncertain' | 'needs-login' | 'interrupted'
  postId?: string
  detail: string
}

export type AlertSink = (alert: Alert) => void

export function createLogAlert(log: ReturnType<typeof createLog>): AlertSink {
  return (alert) => log(`ALERT ${alert.kind} post=${alert.postId ?? '-'} ${alert.detail}`)
}
