import type { EntryChecks } from './entries'
import { REVIEW_SCOPE } from './findings'

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLE = [
  '*{box-sizing:border-box}',
  'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:680px;',
  'margin:0 auto;padding:24px 16px 96px;background:#e6eaf1;color:#0b1426}',
  'h1{font-size:26px;margin:0 0 4px}',
  'p,label,textarea,input,button,.meta,.preview,.checks,.scope,.error,.locked{font-size:15px;line-height:1.5}',
  'label{display:block;font-weight:600;margin:16px 0 6px}',
  'textarea,input[type=datetime-local]{width:100%;padding:10px;border:1px solid #c5cedb;border-radius:8px;',
  'font:inherit;background:#fff}',
  'textarea{min-height:160px;white-space:pre-wrap}',
  'button{font-size:16px;font-weight:700;padding:14px 22px;border-radius:999px;border:none;',
  'cursor:pointer;margin:16px 8px 0 0;color:#fff;min-height:48px;background:#0b1426}',
  'button.reject{background:#dc2626}',
  'button.approve{background:#16a34a}',
  '.meta{color:#6b7686;margin:0 0 16px}',
  '.preview,.checks{background:#fff;border:1px solid #e8edf4;border-radius:12px;padding:16px;margin:16px 0}',
  '.preview .text{white-space:pre-wrap;margin:0 0 8px}',
  '.blocked{color:#dc2626;font-weight:600}',
  '.hint{color:#8a6d1f}',
  '.scope{color:#566174;font-size:13px;margin-top:8px}',
  '.error,.locked{color:#8a6d1f;background:#fff8e6;border:1px solid #f1e0a8;border-radius:8px;padding:10px;margin:12px 0}',
  '.state{font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase}',
  'a{color:#0b1426;font-weight:600}'
].join('')

const HEAD =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex, nofollow">' +
  `<style>${STYLE}</style>`

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>${escapeHtml(title)}</title></head><body>${body}</body></html>`
}

function renderChecks(recorded: EntryChecks | null | undefined): string {
  if (recorded === undefined) {
    return `<div class="checks"><p class="scope">${escapeHtml(REVIEW_SCOPE)}</p></div>`
  }
  if (recorded === null) {
    return (
      `<div class="checks">` +
      `<div class="blocked">No usable review check is recorded.</div>` +
      `<p class="scope">${escapeHtml(REVIEW_SCOPE)}</p>` +
      `</div>`
    )
  }
  const lines = [
    ...recorded.blocking.map((line) => `<div class="blocked">${escapeHtml(line)}</div>`),
    ...(recorded.hints ?? []).map((line) => `<div class="hint">${escapeHtml(line)}</div>`)
  ]
  if (lines.length === 0) {
    lines.push('<div>No blocking findings and no hints.</div>')
  }
  lines.push(`<p class="scope">${escapeHtml(REVIEW_SCOPE)}</p>`)
  return `<div class="checks">${lines.join('')}</div>`
}

export function renderPlainPage(title: string, message: string): string {
  return page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`)
}

export type ComposerPageInput = {
  text: string
  scheduledAt: string
  error?: string
  /** Omit on a blank form. null is "no usable check", not an empty result. */
  recorded?: EntryChecks | null
  charCount: number
  costHint: string
}

export function renderComposerPage(input: ComposerPageInput): string {
  const error = input.error
    ? `<div class="error">${escapeHtml(input.error)}</div>`
    : ''
  const findings = renderChecks(input.recorded)
  const body = `
<h1>Outbox</h1>
<p class="meta">Submit for approval. There is no publish or schedule action without an approver.</p>
${error}
<form method="post" action="/api/submit">
  <label for="text">Text</label>
  <textarea id="text" name="text" required>${escapeHtml(input.text)}</textarea>
  <label for="scheduledAt">Scheduled time (Europe/Zurich)</label>
  <input id="scheduledAt" name="scheduledAt" type="datetime-local" required value="${escapeHtml(input.scheduledAt)}">
  <button type="submit">Submit for approval</button>
</form>
<div class="preview">
  <div class="text">${input.text ? escapeHtml(input.text) : '<em>Preview</em>'}</div>
  <p class="meta">${input.charCount} characters. ${escapeHtml(input.costHint)}</p>
</div>
${findings}`
  return page('Outbox', body)
}

export type ReviewPageInput = {
  bundleId: string
  text: string
  scheduledLabel: string
  state: string
  /** null is "no usable check", not an empty result. */
  recorded: EntryChecks | null
  lockReason: string | null
  approver: boolean
}

export function renderReviewPage(input: ReviewPageInput): string {
  const lock = input.lockReason
    ? `<div class="locked">${escapeHtml(input.lockReason)}</div>`
    : ''
  const showApprove =
    input.approver && input.state === 'submitted' && input.lockReason === null
  const showReject = input.approver && input.state === 'submitted'
  let actions = ''
  if (showReject) {
    const approve = showApprove
      ? '<button class="approve" type="submit" name="decision" value="approve">Approve</button>'
      : ''
    actions = `<form method="post" action="/review/${encodeURIComponent(input.bundleId)}/decide">${approve}<button class="reject" type="submit" name="decision" value="reject">Reject</button></form>`
  }
  const body = `
<h1>Review</h1>
<p class="meta"><span class="state">${escapeHtml(input.state)}</span> · ${escapeHtml(input.scheduledLabel)}</p>
${lock}
<div class="preview"><div class="text">${escapeHtml(input.text)}</div></div>
${renderChecks(input.recorded)}
${actions}`
  return page('Review', body)
}
