import { describe, expect, it } from 'vitest'
import {
  renderComposerPage,
  renderPlainPage,
  renderReviewPage
} from './html'

const review = (overrides: Partial<Parameters<typeof renderReviewPage>[0]> = {}) => renderReviewPage({
  bundleId: 'bundle-1',
  text: 'A reviewed post.',
  scheduledLabel: '15 Jul 2024, 12:00',
  state: 'submitted',
  recorded: { blocking: [], hints: [] },
  lockReason: null,
  approver: true,
  channel: null,
  ...overrides
})

describe('composer markup', () => {
  it('escapes every dynamic composer text field', () => {
    const value = "<x>&'"
    const escaped = '&lt;x&gt;&amp;&#39;'
    const html = renderComposerPage({
      text: value,
      scheduledAt: value,
      error: value,
      charCount: 1,
      costHint: value,
      recorded: { blocking: [value], hints: [value] }
    })
    expect(html).not.toContain(value)
    expect(html).toContain(`<textarea id="text" name="text" required>${escaped}</textarea>`)
    expect(html).toContain(`value="${escaped}"`)
    expect(html).toContain(`<div class="callout error"><svg`)
    expect(html).toContain(`<p>${escaped}</p>`)
    expect(html).toContain(`<div class="finding blocked"><svg`)
    expect(html).toContain(`<div class="finding hint"><svg`)
    expect([...html.matchAll(new RegExp(`<span>${escaped}</span>`, 'g'))]).toHaveLength(2)
  })

  it('renders the accessible 5-minute schedule, image field, preview and escaped content', () => {
    const html = renderComposerPage({
      text: '<script>alert("x")</script>',
      scheduledAt: '2024-07-15T12:00',
      charCount: 32,
      costHint: 'Cost estimate < 1 CHF',
      recorded: null,
      error: 'Review pack is missing.'
    })

    expect(html).toContain('method="post" action="/api/submit"')
    expect(html).toContain('id="text" name="text"')
    expect(html).toContain('id="scheduledDate" name="scheduledDate" type="date"')
    expect(html).toContain('id="scheduledHour" name="scheduledHour"')
    expect(html).toContain('id="scheduledMinute" name="scheduledMinute"')
    expect(html).toContain('enctype="multipart/form-data"')
    expect(html).toContain('name="image" type="file"')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('<span class="tabular" id="character-count">32</span> characters.')
    expect(html).toContain('Cost estimate &lt; 1 CHF')
    expect(html).toContain('No usable review check is recorded.')
    expect(html).toContain('Review pack is missing.')
  })

  it('shows the labelled chip and positive result icon for an empty recorded check', () => {
    const html = renderComposerPage({
      text: '',
      scheduledAt: '',
      charCount: 0,
      costHint: 'No cost estimate.',
      recorded: { blocking: [], hints: [] }
    })

    expect(html).toContain('<em>Preview</em>')
    expect(html).toContain('No blocking findings and no hints.')
    expect(html).toContain('Review checks')
    expect(html).toContain('aria-hidden="true"')
  })

  it('renders the submit button enabled when a blocking finding is recorded', () => {
    const html = renderComposerPage({
      text: 'A blocking claim.',
      scheduledAt: '',
      charCount: 18,
      costHint: 'No cost estimate.',
      recorded: { blocking: ['x'], hints: [] }
    })
    const submitButton = html.match(/<button id="submit-button"[^>]*>/)?.[0]

    expect(submitButton).toBeDefined()
    expect(submitButton).not.toMatch(/\sdisabled(?:\s|=|>)/)
  })

  it('omits the checked scope and renders the empty-state hint', () => {
    const blank = renderComposerPage({
      text: '',
      scheduledAt: '',
      charCount: 0,
      costHint: 'No cost estimate.'
    })
    const withFinding = renderComposerPage({
      text: '',
      scheduledAt: '',
      charCount: 0,
      costHint: 'No cost estimate.',
      recorded: { blocking: ['A blocking finding.'], hints: [] }
    })

    expect(blank).toContain('Checks appear here as you type.')
    expect(blank).not.toContain('Checked:')
    expect(withFinding).toContain('A blocking finding.')
    expect(withFinding).not.toContain('Checked:')
  })
})

describe('review markup', () => {
  it('omits the Checked scope line from review findings too', () => {
    const html = review({ recorded: { blocking: [], hints: [] } })
    expect(html).toContain('No blocking findings and no hints.')
    expect(html).not.toContain('Checked:')
  })

  it('escapes every dynamic review text field and encodes action path identifiers', () => {
    const value = "<x>&'"
    const escaped = '&lt;x&gt;&amp;&#39;'
    const html = review({
      bundleId: 'a/b?c#d',
      text: value,
      scheduledLabel: value,
      state: value,
      recorded: { blocking: [value], hints: [value] },
      lockReason: value,
      channel: { postId: 'a/b?c#d', channel: value, status: value, url: `https://example.test/post?q=${value}` }
    })
    expect(html).not.toContain(value)
    expect(html).toContain(`<span class="status status-unknown">${escaped}</span>`)
    expect(html).toContain(`<span class="meta tabular">${escaped}</span>`)
    expect(html).toContain(`<div class="text">${escaped}</div>`)
    expect(html).toContain(`<div class="callout locked"><svg`)
    expect(html).toContain(`<p>${escaped}</p>`)
    expect(html).toContain(`Channel: ${escaped}</span>`)
    expect(html).toContain(`class="status status-unknown">${escaped}</span>`)
    expect(html).toContain(`<div class="finding blocked"><svg`)
    expect(html).toContain(`<div class="finding hint"><svg`)

    const decideHtml = review({ bundleId: 'a/b?c#d', state: 'submitted', approver: true, lockReason: null })
    expect(decideHtml).toContain('/review/a%2Fb%3Fc%23d/decide')

    const uncertainHtml = review({
      state: 'approved',
      channel: { postId: 'a/b?c#d', channel: 'x', status: 'uncertain', url: null }
    })
    expect(uncertainHtml).toContain('/api/posts/a%2Fb%3Fc%23d/resolve-uncertain')

    const retryHtml = review({
      state: 'approved',
      channel: { postId: 'a/b?c#d', channel: 'x', status: 'failed', url: null }
    })
    expect(retryHtml).toContain('/api/posts/a%2Fb%3Fc%23d/retry')

    const urlHtml = review({
      state: 'approved',
      channel: { postId: 'post-1', channel: 'x', status: 'sent', url: `https://example.test/post?q=${value}` }
    })
    expect(urlHtml).not.toContain(value)
    expect(urlHtml).toContain(`href="https://example.test/post?q=${escaped}"`)
  })

  it.each([
    ['submitted', 'status-submitted', 'entry'],
    ['approved', 'status-approved', 'entry'],
    ['rejected', 'status-rejected', 'entry'],
    ['retracted', 'status-retracted', 'entry'],
    ['pending', 'status-pending', 'channel'],
    ['in-flight', 'status-in-flight', 'channel'],
    ['sent', 'status-sent', 'channel'],
    ['failed', 'status-failed', 'channel'],
    ['uncertain', 'status-uncertain', 'channel']
  ])('renders the %s status name in its labelled chip', (status, className, target) => {
    const html = target === 'entry'
      ? review({ state: status })
      : review({ channel: { postId: 'post-1', channel: 'x', status, url: null } })

    expect(html).toContain(`class="status ${className}">${status}</span>`)
  })

  it('shows approve and reject only for an approver reviewing an unlocked submission', () => {
    const html = review()
    expect(html).toContain('value="approve">Approve</button>')
    expect(html).toContain('value="reject">Reject</button>')
    expect(review({ approver: false })).not.toContain('>Approve</button>')
    expect(review({ state: 'approved' })).not.toContain('>Reject</button>')
    const locked = review({ lockReason: 'The scheduled time has already passed.' })
    expect(locked).not.toContain('value="approve"')
    expect(locked).toContain('value="reject">Reject</button>')
  })

  it('limits retry to approvers for failed channel posts', () => {
    const failed = { postId: 'post-1', channel: 'x', status: 'failed', url: null }
    expect(review({ state: 'approved', channel: failed })).toContain('>Retry</button>')
    expect(review({ state: 'approved', channel: failed, approver: false })).not.toContain('>Retry</button>')
    expect(review({ state: 'approved', channel: { ...failed, status: 'pending' } })).not.toContain('>Retry</button>')
  })

  it('limits uncertain resolution forms to approvers and labels both status chips', () => {
    const uncertain = { postId: 'post-1', channel: 'x', status: 'uncertain', url: null }
    const html = review({ state: 'approved', channel: uncertain })
    expect(html).toContain('name="resolution" value="sent"')
    expect(html).toContain('name="resolution" value="failed"')
    expect(html).toContain('id="post-url" name="url" type="url"')
    expect(html).toContain('class="status status-approved">approved</span>')
    expect(html).toContain('class="status status-uncertain">uncertain</span>')
    const author = review({ state: 'approved', channel: uncertain, approver: false })
    expect(author).not.toContain('name="resolution"')
    expect(author).not.toContain('Mark as sent')
  })

  it('shows the published link only for a sent channel with a URL', () => {
    const sent = { postId: 'post-1', channel: 'x', status: 'sent', url: 'https://x.com/post/1?a=1&b=2' }
    const html = review({ state: 'approved', channel: sent })
    expect(html).toContain('class="status status-sent">sent</span>')
    expect(html).toContain('View published post')
    expect(html).toContain('href="https://x.com/post/1?a=1&amp;b=2"')
    expect(review({ state: 'approved', channel: { ...sent, status: 'pending' } })).not.toContain('View published post')
    expect(review({ state: 'approved', channel: { ...sent, url: null } })).not.toContain('View published post')
  })

  it('escapes text, channel labels, and status labels', () => {
    const html = review({
      text: '<img src=x onerror=alert(1)>',
      state: 'submitted<bad>',
      channel: { postId: 'post-1', channel: 'x<&', status: 'pending', url: null }
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).toContain('submitted&lt;bad&gt;')
    expect(html).toContain('Channel: x&lt;&amp;')
    expect(html).not.toContain('<img src=x')
  })
})

describe('plain result page kind', () => {
  it('escapes dynamic hint page titles and messages', () => {
    const value = "<x>&'"
    const escaped = '&lt;x&gt;&amp;&#39;'
    const html = renderPlainPage(value, value)
    expect(html).not.toContain(value)
    expect(html).toContain(`<title>${escaped}</title>`)
    expect(html).toContain(`<h1>${escaped}</h1>`)
    expect(html).toContain(`<p>${escaped}</p>`)
  })

  it.each([
    ['Decided', 'success'],
    ['Post updated', 'success'],
    ['Request failed', 'error'],
    ['Forbidden', 'error'],
    ['Error', 'error'],
    ['Sign in required', 'neutral']
  ])('chooses the %s result treatment', (title, kind) => {
    expect(renderPlainPage(title, 'Result message.')).toContain(`result-icon ${kind}`)
  })

  it('keeps plain-page title and message escaped and unchanged', () => {
    const html = renderPlainPage('Request failed', '<bad & message>')
    expect(html).toContain('<h1>Request failed</h1>')
    expect(html).toContain('&lt;bad &amp; message&gt;')
  })
})
