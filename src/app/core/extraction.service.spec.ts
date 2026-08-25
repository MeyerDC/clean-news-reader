import { describe, expect, it } from 'vitest';

import { ExtractionService } from './extraction.service';

const service = new ExtractionService();
const URL = 'https://example.com/news/story';

/** Builds a page with a body of roughly [words] words of real prose. */
function page(bodyHtml: string, headExtra = ''): string {
  return `<!doctype html><html><head><title>Test page</title>${headExtra}</head>
    <body><article>${bodyHtml}</article></body></html>`;
}

function prose(sentences: number): string {
  const sentence =
    'The committee met on Tuesday to consider the report and its recommendations for the coming year. ';
  return Array.from({ length: sentences }, () => sentence).join('');
}

describe('extraction failure rules (FR-4)', () => {
  it('accepts a page with a real article body', () => {
    const result = service.extractFromHtml(page(`<h1>A real story</h1><p>${prose(12)}</p>`), URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.textLength).toBeGreaterThanOrEqual(500);
      expect(result.bodyHtml).toContain('<p>');
    }
  });

  it('fails when the body is under 500 characters', () => {
    const result = service.extractFromHtml(page('<p>Only a sentence or two here.</p>'), URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('other');
  });

  it('fails when there is no article body at all', () => {
    const result = service.extractFromHtml('<!doctype html><html><body></body></html>', URL);
    expect(result.ok).toBe(false);
  });

  // FR-7 renders a paywall differently from a generic failure, so the
  // classification has to be right, not just the pass/fail.
  it.each([
    'Subscribe to continue reading',
    'This article is for subscribers',
    'Register to continue reading this article',
    'Sign in to continue reading',
    'Create a free account to continue',
  ])('classifies "%s" as a paywall', (teaser) => {
    const result = service.extractFromHtml(
      page(`<p>${prose(3)}</p><p>${teaser}</p>`),
      URL,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('paywall');
  });

  it('does not cry paywall over an article that merely mentions subscriptions', () => {
    const result = service.extractFromHtml(
      page(`<p>${prose(12)} The company said its subscriber numbers had grown.</p>`),
      URL,
    );
    expect(result.ok).toBe(true);
  });
});

describe('body cleaning (FR-4)', () => {
  it('removes scripts, forms, related rails and comment blocks', () => {
    const result = service.cleanBody(
      `<p>${prose(12)}</p>
       <script>window.tracker = 1;</script>
       <form class="newsletter"><input name="email"></form>
       <div class="related-articles"><a href="/x">More from us</a></div>
       <section id="comments"><p>First!</p></section>
       <div class="cookie-consent">We use cookies</div>`,
      URL,
    );

    expect(result.html).not.toContain('<script');
    expect(result.html).not.toContain('<form');
    expect(result.html).not.toContain('<input');
    expect(result.text).not.toContain('More from us');
    expect(result.text).not.toContain('First!');
    expect(result.text).not.toContain('We use cookies');
    expect(result.text).toContain('The committee met');
  });

  it('strips event handlers and javascript: links', () => {
    const result = service.cleanBody(
      `<p onclick="steal()">${prose(2)}</p><a href="javascript:alert(1)">tap</a>`,
      URL,
    );
    expect(result.html).not.toContain('onclick');
    expect(result.html).not.toContain('javascript:');
  });

  it('keeps headings, lists, blockquotes and inline links', () => {
    const result = service.cleanBody(
      `<h2>Background</h2><ul><li>One</li></ul>
       <blockquote>Quoted</blockquote><p>See <a href="/more">this</a>.</p>`,
      URL,
    );
    expect(result.html).toContain('<h2>');
    expect(result.html).toContain('<li>');
    expect(result.html).toContain('<blockquote>');
    // Relative links are resolved against the article's own URL.
    expect(result.html).toContain('https://example.com/more');
  });

  it('preserves figure captions and resolves image sources (FR-5)', () => {
    const result = service.cleanBody(
      `<figure><img src="/img/lead.jpg"><figcaption>A caption</figcaption></figure>
       <p>${prose(2)}</p>`,
      URL,
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('https://example.com/img/lead.jpg');
    expect(result.images[0].caption).toBe('A caption');
  });

  it('prefers a lazy-loading attribute over a placeholder src', () => {
    const result = service.cleanBody(
      `<img src="data:image/gif;base64,R0lGOD" data-src="https://cdn.example.com/real.jpg">
       <p>${prose(2)}</p>`,
      URL,
    );
    expect(result.images[0].url).toBe('https://cdn.example.com/real.jpg');
  });

  it('drops a byline the reader already shows above the text', () => {
    const result = service.cleanBody(
      `<p>By Jane Doe | Published 7 minutes ago</p><p>${prose(12)}</p>`,
      URL,
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
  });

  it('keeps a real opening paragraph that happens to be short', () => {
    const result = service.cleanBody(`<p>It rained all week.</p><p>${prose(12)}</p>`, URL);
    expect(result.text.startsWith('It rained all week.')).toBe(true);
  });
});

describe('metadata', () => {
  it('reads the publication date and lead image from meta tags', () => {
    const result = service.extractFromHtml(
      page(
        `<h1>Story</h1><p>${prose(12)}</p>`,
        `<meta property="article:published_time" content="2026-08-25T06:30:00Z">
         <meta property="og:image" content="https://cdn.example.com/lead.jpg">
         <meta property="og:site_name" content="Example News">`,
      ),
      URL,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.publishedAt).toBe(Date.parse('2026-08-25T06:30:00Z'));
      expect(result.leadImageUrl).toBe('https://cdn.example.com/lead.jpg');
      expect(result.sourceName).toBe('Example News');
    }
  });
});

describe('leading chrome removal', () => {
  const prose12 =
    'The committee met on Tuesday to consider the report and its recommendations for the coming year. '.repeat(
      12,
    );

  it('drops a stacked date and byline above the first paragraph', () => {
    const result = service.cleanBody(
      `<p>20 Aug</p><p>By Maya Fisher-French</p><p>${prose12}</p>`,
      'https://example.com/a',
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
  });

  it('sees through the wrapper div that Readability emits', () => {
    const result = service.cleanBody(
      `<div id="readability-page-1" class="page">
         <div><p>20 Aug</p><p>By Maya Fisher-French</p><p>${prose12}</p></div>
       </div>`,
      'https://example.com/a',
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
  });

  it('drops a leading block that is exactly the known author', () => {
    const result = service.cleanBody(
      `<p>Maya Fisher-French</p><p>${prose12}</p>`,
      'https://example.com/a',
      'Maya Fisher-French',
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
  });

  it('keeps a bare name when it is not the article author', () => {
    const result = service.cleanBody(
      `<p>Andries Helani</p><p>${prose12}</p>`,
      'https://example.com/a',
      'Tania Broughton',
    );
    expect(result.text.startsWith('Andries Helani')).toBe(true);
  });

  it('handles a date and byline nested at different depths', () => {
    // The shape News24 actually produces.
    const result = service.cleanBody(
      `<div><div>
         <p>20 Aug</p>
         <div><p>Maya Fisher-French</p><div><p>${prose12}</p></div></div>
       </div></div>`,
      'https://example.com/a',
      'Maya Fisher-French',
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
  });

  it('drops the date and byline from real News24 markup', () => {
    // Trimmed from an article this app actually extracted: the date sits at one
    // depth, the byline at another, and a logo image sits alongside the byline.
    const result = service.cleanBody(
      `<div><div>
         <p>20 Aug</p>
         <div>
           <p>
               Maya Fisher-French
           </p>
           <div><p><a href="https://www.news24.com/"><img alt="accreditation"
              src="https://news24cobalt.24.co.za/news24.svg"></a></p></div>
         </div>
         <div><p>${prose12}</p></div>
       </div></div>`,
      'https://example.com/a',
      'Maya Fisher-French',
    );
    expect(result.text).not.toContain('20 Aug');
    expect(result.text).not.toContain('Maya Fisher-French');
    expect(result.text).toContain('The committee met');
  });

  it('judges an opening paragraph on the whole sentence, not a leading link', () => {
    const result = service.cleanBody(
      `<p><a href="/x">Published research</a> ${prose12}</p>`,
      'https://example.com/a',
    );
    expect(result.text).toContain('Published research');
  });

  it('drops a masthead image that links back to the site front page', () => {
    const result = service.cleanBody(
      `<p><a href="https://example.com/"><img alt="accreditation" src="/logo.svg"></a></p>
       <p>${prose12}</p>`,
      'https://example.com/news/story',
    );
    expect(result.images).toHaveLength(0);
    expect(result.html).not.toContain('logo.svg');
  });

  it('keeps article art that links to a related story', () => {
    const result = service.cleanBody(
      `<figure><a href="https://example.com/news/other"><img alt="Court building"
         src="/photo.jpg"></a></figure><p>${prose12}</p>`,
      'https://example.com/news/story',
    );
    expect(result.images).toHaveLength(1);
    expect(result.images[0].url).toBe('https://example.com/photo.jpg');
  });

  it('clears a stacked audio player above the article', () => {
    const result = service.cleanBody(
      `<p>0:00</p><p>Subscribers can listen to this article</p><p>${prose12}</p>`,
      'https://example.com/a',
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
  });

  it('keeps a time that is part of a sentence', () => {
    const result = service.cleanBody(
      `<p>The hearing resumes at 9:30 tomorrow morning in Randburg. ${prose12}</p>`,
      'https://example.com/a',
    );
    expect(result.text).toContain('9:30');
  });

  it('stops at the first real paragraph', () => {
    const result = service.cleanBody(
      `<p>Published 7 minutes ago</p><p>${prose12}</p><p>20 Aug</p>`,
      'https://example.com/a',
    );
    expect(result.text.startsWith('The committee met')).toBe(true);
    // A date deeper in the article is content, not chrome.
    expect(result.text).toContain('20 Aug');
  });
});

describe('video posts', () => {
  const caption = 'Watch the full proceedings from the Randburg court. '.repeat(3);
  const realArticle =
    'The committee met on Tuesday to consider the report and its recommendations for the coming year. '.repeat(
      20,
    );
  const embed = '<iframe src="https://www.youtube.com/embed/l-fHQr9JH8E"></iframe>';

  function videoPage(body: string): string {
    return `<!doctype html><html><head><title>WATCH | Court</title></head>
      <body><article>${body}</article></body></html>`;
  }

  it('calls a page with a player and a caption a video, not a failed article', () => {
    const result = service.extractFromHtml(videoPage(`${embed}<p>${caption}</p>`), URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('video');
  });

  // The case a bare character count gets wrong: one real video post cleared
  // the 500 bar with 692 characters and rendered as a stunted article.
  it('catches a video post that clears the 500-character bar', () => {
    const sixHundred = 'a '.repeat(300);
    const result = service.extractFromHtml(videoPage(`${embed}<p>${sixHundred}</p>`), URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('video');
  });

  it('still reads a real article that happens to carry a video', () => {
    const result = service.extractFromHtml(videoPage(`<p>${realArticle}</p>${embed}`), URL);
    expect(result.ok).toBe(true);
  });

  it('leaves a marker where the embed was, so nothing vanishes silently', () => {
    const result = service.cleanBody(`<p>${realArticle}</p>${embed}`, URL);
    expect(result.html).toContain('data-cn-video');
    expect(result.html).not.toContain('<iframe');
    expect(result.text).toContain('watch on the original page');
  });

  it('still notes the video when Readability discarded the embed', () => {
    // The real shape: the player sits outside the article node, so the body
    // Readability returns has no iframe in it at all.
    const page = `<!doctype html><html><head>
        <meta property="og:video" content="https://x/v.mp4"></head>
      <body>
        <div class="player">${embed}</div>
        <article><p>${realArticle}</p></article>
      </body></html>`;
    const result = service.extractFromHtml(page, URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyHtml).toContain('data-cn-video');
      expect(result.bodyHtml).not.toContain('<iframe');
    }
  });

  it('does not add a second marker when one is already in place', () => {
    const page = videoPage(`<p>${realArticle}</p>${embed}`);
    const result = service.extractFromHtml(page, URL);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.bodyHtml.match(/data-cn-video/g)?.length ?? 0).toBe(1);
    }
  });

  it('ignores a non-video iframe', () => {
    const analytics = '<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-X"></iframe>';
    const result = service.extractFromHtml(videoPage(`${analytics}<p>${realArticle}</p>`), URL);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bodyHtml).not.toContain('data-cn-video');
  });

  it('detects an og:video declaration even with no embed in the body', () => {
    const doc = new DOMParser().parseFromString(
      `<html><head><meta property="og:video" content="https://x/v.mp4"></head><body></body></html>`,
      'text/html',
    );
    expect(service.hasVideoEmbed(doc)).toBe(true);
  });
});
