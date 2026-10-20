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
  it('keeps the original form contract, labels, preview details, and escaped content', () => {
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
    expect(html).toContain('id="scheduledAt" name="scheduledAt" type="datetime-local"')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('<span class="tabular">32</span> characters. Cost estimate &lt; 1 CHF')
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

  it('omits the scope divider on a blank form and shows it after a finding', () => {
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

    expect(blank).toContain('<p class="scope">')
    expect(blank).not.toContain('<p class="scope separated">')
    expect(withFinding).toContain('A blocking finding.')
    expect(withFinding).toContain('<p class="scope separated">')
  })
})

describe('review markup', () => {
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
