import { describe, expect, it } from 'vitest'
import { HandbookMarkdownError, renderMarkdown } from './markdown'

describe('handbook markdown renderer', () => {
  it('renders only the supported escaped Markdown subset', () => {
    const html = renderMarkdown('# Title\n\nA **bold** word and `code`.\n\n- first\n- [safe](https://x.com/handbook_demo/status/12345)\n- [jump](#section)', 'guide.md')
    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<a href="https://x.com/handbook_demo/status/12345">safe</a>')
    expect(html).toContain('<a href="#section">jump</a>')
  })

  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<iframe src="https://example.com"></iframe>',
    '&#x3c;script&#x3e;alert(1)'
  ])('escapes raw markup and entity text: %s', (text) => {
    const html = renderMarkdown(text, 'guide.md')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<iframe')
    if (text.startsWith('&#x3c;')) expect(html).toContain('&amp;#x3c;')
    else expect(html).toContain('&lt;')
  })

  it('keeps Markdown punctuation in link targets inside the escaped href', () => {
    const html = renderMarkdown('[code](https://x.com/a`b) [bold](https://x.com/a**b)', 'guide.md')
    expect(html).toContain('<a href="https://x.com/a`b">code</a>')
    expect(html).toContain('<a href="https://x.com/a**b">bold</a>')
    expect(html).not.toContain('<code>b</a>')
    expect(html).not.toContain('<strong>b</a>')
  })

  it('does not apply inline markup to a link destination', () => {
    const html = renderMarkdown('[a](https://x.com/**b**)', 'guide.md')
    expect(html).toContain('<a href="https://x.com/**b**">a</a>')
    expect(html).not.toContain('<strong>')
    expect(html).not.toContain('<strong>b</strong>')
  })

  it.each(['&#1114112;', '&#x110000;'])('reports the first invalid numeric code point %s with its source file and line', (reference) => {
    expect(() => renderMarkdown(`before\n\n[x](https://x.com/${reference})`, 'guide.md'))
      .toThrow('guide.md:3: invalid numeric character reference')
  })

  it('does not report the last valid Unicode code point as an invalid numeric character reference', () => {
    try {
      renderMarkdown('before\n\n[x](https://x.com/&#1114111;)', 'guide.md')
    } catch (error) {
      expect((error as Error).message).not.toContain('invalid numeric character reference')
    }
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' data:text/html,hello',
    'vbscript:alert(1)',
    'http://example.com',
    '//example.com/path',
    'relative/path',
    'javascript&#58;alert(1)',
    'javascript&#x3a;alert(1)',
    'jav&#x61;script&#58;alert(1)'
  ])('rejects unsafe link targets with source line: %s', (target) => {
    expect(() => renderMarkdown(`before\n\n[x](${target})`, 'guide.md')).toThrow(HandbookMarkdownError)
    try { renderMarkdown(`before\n\n[x](${target})`, 'guide.md') } catch (error) {
      expect((error as Error).message).toContain('guide.md:3:')
    }
  })

  it.each([
    'https://user:pw@x.com/a',
    'https://user@x.com'
  ])('rejects HTTPS URLs containing user information: %s', (target) => {
    expect(() => renderMarkdown(`[x](${target})`, 'guide.md')).toThrow(HandbookMarkdownError)
  })
})
