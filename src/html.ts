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
  '@font-face{font-family:Inter;src:url("/assets/fonts/Inter-Regular.woff2") format("woff2");font-style:normal;font-weight:400;font-display:swap}',
  '@font-face{font-family:Inter;src:url("/assets/fonts/Inter-SemiBold.woff2") format("woff2");font-style:normal;font-weight:600;font-display:swap}',
  '@font-face{font-family:Inter;src:url("/assets/fonts/Inter-Bold.woff2") format("woff2");font-style:normal;font-weight:700;font-display:swap}',
  '*{box-sizing:border-box}',
  ':root{color-scheme:light;--bg:#f6f8fc;--surface:#fff;--surface-soft:#eef3fa;--text:#0b1426;--text-secondary:#566174;--text-muted:#8d98aa;--border:#dde5f0;--primary:#1e6ef7;--primary-hover:#0b57cf;--primary-soft:#e6f0ff;--primary-ink:#174ea6;--success:#16a34a;--success-ink:#166534;--success-soft:#dcfce7;--warning:#8a5a00;--warning-ink:#754700;--warning-soft:#fff4d6;--warning-border:#f1d58e;--error:#b91c1c;--error-ink:#991b1b;--error-soft:#fee2e2;--error-border:#f4b4b4;--neutral:#566174;--neutral-soft:#eef2f7;--primary-text:#fff;--transparent:transparent;--radius-sm:6px;--radius-md:10px;--radius-lg:16px;--radius-button:14px;--radius-pill:999px;--radius-circle:50%;--space-1:4px;--space-2:8px;--space-2_5:10px;--space-3:12px;--space-4:16px;--space-5:24px;--space-6:32px;--space-7:48px;--shadow-card:0 6px 20px rgba(11,20,38,.05);--shadow-button:0 4px 12px rgba(11,87,207,.18);--shadow-button-hover:0 6px 16px rgba(11,87,207,.22)}',
  'body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:16px;line-height:1.55;-webkit-font-smoothing:antialiased}',
  'main{width:min(100% - 32px,720px);margin:0 auto;padding:var(--space-5) 0 var(--space-7)}',
  '.brand{display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-6);color:var(--text-secondary);font-size:14px;font-weight:600;letter-spacing:.01em}',
  '.brand svg{display:block;width:77px;height:24px;flex:none}',
  'h1{margin:0 0 var(--space-2);font-size:26px;line-height:1.2;letter-spacing:-.025em}',
  'p{margin:0 0 var(--space-3)}',
  '.meta,.scope,.secondary{color:var(--text-secondary);font-size:13px;line-height:1.5}',
  '.tabular{font-variant-numeric:tabular-nums}',
  '.intro{max-width:66ch;margin:0 0 var(--space-5)}',
  '.card{min-width:0;margin:var(--space-4) 0;padding:var(--space-4);background:var(--surface);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-card)}',
  '.form-card{padding:var(--space-4)}',
  'label{display:block;margin:0 0 var(--space-2);font-size:14px;font-weight:600}',
  'textarea,input[type=datetime-local],input[type=url]{display:block;width:100%;min-height:48px;padding:var(--space-3);border:1px solid var(--border);border-radius:var(--radius-md);background:var(--surface);color:var(--text);font:inherit;line-height:1.45}',
  'textarea{min-height:160px;resize:vertical;white-space:pre-wrap}',
  'textarea:focus-visible,input:focus-visible{outline:2px solid var(--primary);outline-offset:2px;border-color:var(--primary)}',
  '.field{margin:0 0 var(--space-4)}',
  '.actions{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3);margin-top:var(--space-4)}',
  'button{display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 var(--space-5);border:1px solid var(--transparent);border-radius:var(--radius-button);background:var(--primary);box-shadow:var(--shadow-button);color:var(--primary-text);font:600 16px/1.2 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer;transition:background-color .15s ease,box-shadow .15s ease,transform .15s ease}',
  'button:hover{background:var(--primary-hover);box-shadow:var(--shadow-button-hover)}',
  'button:active{transform:translateY(1px)}',
  'button:focus-visible,a:focus-visible{outline:2px solid var(--primary);outline-offset:3px}',
  'button.destructive{background:var(--surface);border-color:var(--error);box-shadow:none;color:var(--error)}',
  'button.destructive:hover{background:var(--error-soft)}',
  '.meta-row{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-2);margin:0 0 var(--space-4)}',
  '.meta-row>span[aria-hidden="true"]{color:var(--text-muted)}',
  '.status{display:inline-flex;align-items:center;gap:var(--space-2);min-height:28px;padding:var(--space-1) var(--space-2_5);border-radius:var(--radius-pill);font-size:12px;font-weight:700;line-height:1.3;letter-spacing:.01em}',
  '.status-submitted,.status-pending{background:var(--primary-soft);color:var(--primary-ink)}',
  '.status-in-flight{background:var(--primary-soft);color:var(--primary-ink)}',
  '.status-in-flight:before{width:6px;height:6px;border-radius:var(--radius-circle);background:currentColor;content:""}',
  '.status-approved,.status-sent{background:var(--success-soft);color:var(--success-ink)}',
  '.status-rejected,.status-failed{background:var(--error-soft);color:var(--error-ink)}',
  '.status-uncertain{background:var(--warning-soft);color:var(--warning-ink)}',
  '.status-retracted{background:var(--neutral-soft);color:var(--neutral)}',
  '.status-unknown{background:var(--neutral-soft);color:var(--neutral)}',
  '.preview .text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.preview .meta{margin:var(--space-3) 0 0}',
  '.checks{display:grid;gap:var(--space-3)}',
  '.finding{display:flex;align-items:flex-start;gap:var(--space-3);font-weight:600}',
  '.finding svg,.result-icon svg,.callout svg{width:20px;height:20px;flex:none}',
  '.finding.blocked{color:var(--error)}',
  '.finding.hint{color:var(--warning)}',
  '.finding.clear{color:var(--success-ink);font-weight:500}',
  '.scope{margin:0;padding-top:var(--space-3)}',
  '.scope.separated{border-top:1px solid var(--border)}',
  '.callout{display:flex;align-items:flex-start;gap:var(--space-3);margin:var(--space-4) 0;padding:var(--space-3) var(--space-4);border:1px solid var(--border);border-radius:var(--radius-md);font-size:14px}',
  '.callout p{margin:0}',
  '.callout.locked{background:var(--warning-soft);border-color:var(--warning-border);color:var(--warning-ink)}',
  '.callout.error{background:var(--error-soft);border-color:var(--error-border);color:var(--error)}',
  '.channel-line{display:flex;align-items:center;flex-wrap:wrap;gap:var(--space-3);margin:0}',
  'a{color:var(--primary-hover);font-weight:600;text-underline-offset:3px}',
  '.published-link{display:inline-flex;align-items:center;min-height:44px;margin-top:var(--space-3)}',
  '.action-group{display:flex;flex-wrap:wrap;align-items:center;gap:var(--space-3)}',
  '.action-group form{display:contents}',
  '.action-group .field{flex:1 0 100%;margin-bottom:0}',
  '.result-page{min-height:calc(100vh - 72px);display:flex;flex-direction:column}',
  '.result-card{align-self:center;width:100%;max-width:520px;margin:auto;padding:var(--space-6);text-align:center}',
  '.result-icon{display:grid;place-items:center;width:52px;height:52px;margin:0 auto var(--space-4);border-radius:var(--radius-circle)}',
  '.result-icon.success{background:var(--success-soft);color:var(--success-ink)}',
  '.result-icon.error{background:var(--error-soft);color:var(--error)}',
  '.result-icon.neutral{background:var(--surface-soft);color:var(--text-secondary)}',
  '.result-card h1{margin-bottom:var(--space-3)}',
  '.result-card p{color:var(--text-secondary);overflow-wrap:anywhere}',
  '@media(max-width:520px){main{width:calc(100% - 32px);padding-top:var(--space-4)}.brand{margin-bottom:var(--space-5)}.card{padding:var(--space-3)}.result-card{padding:var(--space-5)}}',
  '@media(prefers-reduced-motion:reduce){*,*:before,*:after{scroll-behavior:auto!important;transition:none!important}}'
].join('')

const LOGO = '<svg viewBox="0 0 544 170" role="img" aria-label="DFX" xmlns="http://www.w3.org/2000/svg"><g clip-path="url(#dfx-logo-clip)"><path fill-rule="evenodd" clip-rule="evenodd" d="M61.5031 0H124.245C170.646 0 208.267 36.5427 208.267 84.0393C208.267 131.536 169.767 170.018 122.288 170.018H61.5031V135.504H114.046C141.825 135.504 164.541 112.789 164.541 85.009C164.541 57.2293 141.825 34.5136 114.046 34.5136H61.5031V0ZM266.25 31.5686V76.4973H338.294V108.066H266.25V170H226.906V0H355.389V31.5686H266.25ZM495.76 170L454.71 110.975L414.396 170H369.216L432.12 83.5365L372.395 0H417.072L456.183 55.1283L494.557 0H537.061L477.803 82.082L541.191 170H495.778H495.76Z" fill="#072440"/><path d="M86.1582 126.274C109.821 126.274 129.004 107.092 129.004 83.4287C129.004 59.7657 109.821 40.583 86.1582 40.583C62.4952 40.583 43.3126 59.7657 43.3126 83.4287C43.3126 107.092 62.4952 126.274 86.1582 126.274Z" fill="url(#dfx-logo-p0)"/><path d="M47.1374 132.146C73.1707 132.146 94.2748 111.042 94.2748 85.009C94.2748 58.9757 73.1707 37.8716 47.1374 37.8716C21.1041 37.8716 0 58.9757 0 85.009C0 111.042 21.1041 132.146 47.1374 132.146Z" fill="url(#dfx-logo-p1)"/></g><defs><linearGradient id="dfx-logo-p0" x1="122.111" y1="64.6777" x2="45.9618" y2="103.949" gradientUnits="userSpaceOnUse"><stop offset=".04" stop-color="#F5516C"/><stop offset=".14" stop-color="#C74863"/><stop offset=".31" stop-color="#853B57"/><stop offset=".44" stop-color="#55324E"/><stop offset=".55" stop-color="#382D49"/><stop offset=".61" stop-color="#2D2B47"/></linearGradient><linearGradient id="dfx-logo-p1" x1="75.8868" y1="50.7468" x2="15.2815" y2="122.952" gradientUnits="userSpaceOnUse"><stop offset=".2" stop-color="#F5516C"/><stop offset="1" stop-color="#6B3753"/></linearGradient><clipPath id="dfx-logo-clip"><rect width="541.174" height="170" fill="#fff"/></clipPath></defs></svg>'

const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
  cross: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
  warning: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4m0 3h.01"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
}

const HEAD =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<meta name="robots" content="noindex, nofollow">' +
  `<style>${STYLE}</style>`

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head>${HEAD}<title>${escapeHtml(title)}</title></head><body>${body}</body></html>`
}

function brandHeader(): string {
  return `<header class="brand">${LOGO}<span>Outbox</span></header>`
}

function statusClass(status: string): string {
  const known: Record<string, string> = {
    submitted: 'status-submitted',
    approved: 'status-approved',
    rejected: 'status-rejected',
    retracted: 'status-retracted',
    pending: 'status-pending',
    'in-flight': 'status-in-flight',
    sent: 'status-sent',
    failed: 'status-failed',
    uncertain: 'status-uncertain'
  }
  return known[status] ?? 'status-unknown'
}

function statusChip(status: string): string {
  return `<span class="status ${statusClass(status)}">${escapeHtml(status)}</span>`
}

function renderChecks(recorded: EntryChecks | null | undefined): string {
  if (recorded === undefined) {
    return `<section class="card checks" aria-label="Review checks"><p class="scope">${escapeHtml(REVIEW_SCOPE)}</p></section>`
  }
  if (recorded === null) {
    return (
      `<section class="card checks" aria-label="Review checks">` +
      `<div class="finding blocked">${ICONS.cross}<span>No usable review check is recorded.</span></div>` +
      `<p class="scope separated">${escapeHtml(REVIEW_SCOPE)}</p>` +
      `</section>`
    )
  }
  const lines = [
    ...recorded.blocking.map((line) => `<div class="finding blocked">${ICONS.cross}<span>${escapeHtml(line)}</span></div>`),
    ...(recorded.hints ?? []).map((line) => `<div class="finding hint">${ICONS.warning}<span>${escapeHtml(line)}</span></div>`)
  ]
  if (lines.length === 0) {
    lines.push(`<div class="finding clear">${ICONS.check}<span>No blocking findings and no hints.</span></div>`)
  }
  lines.push(`<p class="scope separated">${escapeHtml(REVIEW_SCOPE)}</p>`)
  return `<section class="card checks" aria-label="Review checks">${lines.join('')}</section>`
}

type PlainPageKind = 'success' | 'error' | 'neutral'

function plainPageKind(title: string): PlainPageKind {
  if (title === 'Decided' || title === 'Post updated') return 'success'
  if (title === 'Sign in required') return 'neutral'
  return 'error'
}

export function renderPlainPage(title: string, message: string): string {
  const kind = plainPageKind(title)
  const icon = kind === 'success' ? ICONS.check : kind === 'neutral' ? ICONS.lock : ICONS.cross
  return page(title, `<main class="result-page">${brandHeader()}<section class="card result-card"><div class="result-icon ${kind}">${icon}</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></section></main>`)
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
    ? `<div class="callout error">${ICONS.cross}<p>${escapeHtml(input.error)}</p></div>`
    : ''
  const findings = renderChecks(input.recorded)
  const body = `
<main>
${brandHeader()}
<h1>Outbox</h1>
<p class="intro meta">Submit for approval. There is no publish or schedule action without an approver.</p>
${error}
<form class="card form-card" method="post" action="/api/submit">
  <div class="field"><label for="text">Text</label><textarea id="text" name="text" required>${escapeHtml(input.text)}</textarea></div>
  <div class="field"><label for="scheduledAt">Scheduled time (Europe/Zurich)</label><input id="scheduledAt" name="scheduledAt" type="datetime-local" required value="${escapeHtml(input.scheduledAt)}"></div>
  <button type="submit">Submit for approval</button>
</form>
<section class="card preview" aria-label="Preview">
  <div class="text">${input.text ? escapeHtml(input.text) : '<em>Preview</em>'}</div>
  <p class="meta"><span class="tabular">${input.charCount}</span> characters. ${escapeHtml(input.costHint)}</p>
</section>
${findings}
</main>`
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
  channel: { postId: string; channel: string; status: string; url: string | null } | null
}

export function renderReviewPage(input: ReviewPageInput): string {
  const lock = input.lockReason
    ? `<div class="callout locked">${ICONS.warning}<p>${escapeHtml(input.lockReason)}</p></div>`
    : ''
  const showApprove =
    input.approver && input.state === 'submitted' && input.lockReason === null
  const showReject = input.approver && input.state === 'submitted'
  let actions = ''
  if (showReject) {
    const approve = showApprove
      ? '<button type="submit" name="decision" value="approve">Approve</button>'
      : ''
    actions = `<form class="actions" method="post" action="/review/${encodeURIComponent(input.bundleId)}/decide">${approve}<button class="destructive" type="submit" name="decision" value="reject">Reject</button></form>`
  }
  const publishedLink = input.channel?.status === 'sent' && input.channel.url
    ? `<a class="published-link" href="${escapeHtml(input.channel.url)}">View published post</a>`
    : ''
  const channel = input.channel
    ? `<section class="card"><p class="channel-line"><span>Channel: ${escapeHtml(input.channel.channel)}</span>${statusChip(input.channel.status)}</p>${publishedLink}</section>`
    : ''
  if (input.approver && channel && input.channel?.status === 'failed') {
    const target = `/api/posts/${encodeURIComponent(input.channel.postId)}/retry`
    actions += `<form class="actions" method="post" action="${target}"><button type="submit">Retry</button></form>`
  }
  if (input.approver && input.channel?.status === 'uncertain') {
    const target = `/api/posts/${encodeURIComponent(input.channel.postId)}/resolve-uncertain`
    actions += `<section class="card action-group">
      <form method="post" action="${target}">
        <input type="hidden" name="resolution" value="sent">
        <div class="field"><label for="post-url">Permalink</label><input id="post-url" name="url" type="url"></div>
        <button type="submit">Mark as sent</button>
      </form>
      <form method="post" action="${target}">
        <input type="hidden" name="resolution" value="failed">
        <button class="destructive" type="submit">Mark as failed</button>
      </form>
    </section>`
  }
  const body = `
<main>
${brandHeader()}
<h1>Review</h1>
<div class="meta-row">${statusChip(input.state)}<span aria-hidden="true">·</span><span class="meta tabular">${escapeHtml(input.scheduledLabel)}</span></div>
${lock}
<section class="card preview"><div class="text">${escapeHtml(input.text)}</div></section>
${renderChecks(input.recorded)}
${channel}
${actions}
</main>`
  return page('Review', body)
}
