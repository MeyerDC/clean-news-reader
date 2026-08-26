import { describe, expect, it } from 'vitest';

import { ExtractionService } from './extraction.service';

/**
 * Jacaranda FM ships this article with no class names anywhere in the body, so
 * every selector-based rule misses it and Readability keeps the lot: the
 * timestamp strip, two share widgets, the social-follow lists, the "more from"
 * rail and twenty-one images, of which two are photographs.
 *
 * The markup below is the real page's shape, trimmed.
 */
const JACARANDA = `
<article>
  <p>Updated <time>Aug. 24, 2026, 7:42 a.m.</time><span>|</span> By <b>Jacaranda FM</b></p>
  <div>
    <p>Sign up:</p>
    <p><a href="/newsletter">Newsletter</a></p>
    <p>Share this:</p>
    <p>
      <a href="https://facebook.com/x"><img src="https://cdn.example/core/images/icons/facebook-f.svg"></a>
      <a href="https://x.com/x"><img src="https://cdn.example/core/images/icons/x-twitter.svg"></a>
    </p>
  </div>
  <figure>
    <img src="https://cdn.example/images/JORDAN_BUHRS_TATTOO.width-800.png">
    <figcaption><img src="https://cdn.example/core/images/icons/camera.svg"><p>Supplied</p></figcaption>
  </figure>
  <p>As part of the Rugby's Greatest Rivalry tour, the Bulls and the All Blacks went head to head on Saturday.</p>
  <p>Buhrs posted a video claiming he was so confident the Bulls would win that he would do whatever the top comment said.</p>
  <blockquote><section><a href="https://tiktok.com/@jacabreakfast">@jacabreakfast</a>
    @Martin Bester, @xolantshinga and @Jordan Buhrs will dye their hair blonde
    <a href="#">#BreakfastWithMartinBester</a><a href="#">#RGR26</a>
    @AllBlacks @Blue_Bulls_Official <a href="#">♬ original sound - Breakfast</a></section></blockquote>
  <p><b>Listen to Jacaranda FM:</b></p>
  <ul>
    <li><b>94.2</b></li>
    <li><a href="/app"><b>Jacaranda FM App</b></a></li>
    <li><a href="http://jacarandafm.com"><b>http://jacarandafm.com</b></a></li>
    <li><b>DStv 858/ OpenView 602</b></li>
  </ul>
  <p><b>Follow us on social media:</b></p>
  <ul>
    <li><a href="https://facebook.com/x"><b>Facebook</b></a></li>
    <li><a href="https://twitter.com/x"><b>Twitter</b></a></li>
    <li><a href="https://instagram.com/x"><b>Instagram</b></a></li>
  </ul>
  <p><b>Image: YouTube/ Screenshot</b></p>
  <section><h4>MORE FROM JACARANDA FM</h4><hr>
    <p><a href="/a">Another story entirely</a></p>
  </section>
  <footer>
    <img src="https://cdn.example/core/images/kagiso-connect-logo.png" alt="Kagiso Connect logo">
    <p>CONNECT WITH US</p>
    <p>© 2026 Kagiso Media Ltd. All rights reserved.</p>
  </footer>
</article>`;

const BASE = 'https://www.jacarandafm.com/shows/breakfast/sa-man-gets-all-blacks-tattoo';

describe('cleaning an article whose chrome carries no class names', () => {
  const service = new ExtractionService();
  const cleaned = service.cleanBody(JACARANDA, BASE, 'Jacaranda FM');
  const text = cleaned.text;

  it('keeps the story', () => {
    expect(text).toContain("Rugby's Greatest Rivalry");
    expect(text).toContain('whatever the top comment said');
  });

  it('keeps the photograph and drops the icons', () => {
    // Two <img> in the fixture are pictures-by-path; the rest are /icons/.
    expect(cleaned.images).toHaveLength(1);
    expect(cleaned.images[0].url).toContain('JORDAN_BUHRS_TATTOO');
  });

  it('drops the timestamp strip we already print ourselves', () => {
    expect(text).not.toContain('7:42');
    expect(text).not.toMatch(/^Updated/);
  });

  it('drops both share widgets and the follow lists', () => {
    expect(text).not.toContain('Share this');
    expect(text).not.toContain('Sign up');
    expect(text).not.toContain('Follow us on social media');
    expect(text).not.toContain('Facebook');
    expect(text).not.toContain('Jacaranda FM App');
  });

  it('drops the stranded label once its links are gone', () => {
    expect(text).not.toContain('Listen to Jacaranda FM');
  });

  it('drops a where-to-find-us list that mixes links with plain entries', () => {
    // "94.2" and "DStv 858" carry no link, which drags the text ratio below
    // any threshold while the list is still plainly a list of destinations.
    expect(text).not.toContain('DStv 858');
    expect(text).not.toContain('94.2');
  });

  it('drops the trailing picture credit', () => {
    expect(text).not.toContain('YouTube/ Screenshot');
  });

  it('cuts the rail and everything after it', () => {
    expect(text).not.toContain('MORE FROM');
    expect(text).not.toContain('Another story entirely');
  });

  it('takes the site footer with it, which sits outside the rail container', () => {
    // The rail is a <section> and the footer follows it, so a cut that stopped
    // at the heading's own parent left the copyright line inside the article.
    expect(text).not.toContain('CONNECT WITH US');
    expect(text).not.toContain('Kagiso Media');
  });

  it('leaves a trace of the social embed rather than its hashtags', () => {
    expect(text).not.toContain('#BreakfastWithMartinBester');
    expect(text).not.toContain('♬');
    expect(text).toContain('Social post');
  });
});

/**
 * EWN publishes no feed at all, so its articles only ever arrive through the
 * share sheet. Its markup is otherwise clean — one thing survived every rule
 * above: a subscription pitch in its own <article> after the story, set in
 * bold italics so it reads as part of the reporting.
 */
describe('a trailing subscription pitch', () => {
  const service = new ExtractionService();
  const EWN = `<div>
    <article>
      <p>The Directorate for Priority Crime Investigations has revealed deep corruption
      and systemic failures in procurement at the Department of Defence.</p>
      <p>"It's not just a department where we can allow criminality to go unattended,"
      said Legoete, who chairs the committee hearing the evidence this week.</p>
    </article>
    <article><p><em><strong>Never miss a major story. Get breaking news and the latest
      developments from South Africa and beyond as they happen.</strong></em></p></article>
  </div>`;

  it('drops the pitch and keeps the story', () => {
    const text = service.cleanBody(EWN, 'https://ewn.co.za/2026/08/26/hawks-expose').text;
    expect(text).toContain('systemic failures in procurement');
    expect(text).not.toContain('Never miss a major story');
  });

  it('leaves the same wording alone when reporting follows it', () => {
    // An article about a newsletter launch uses the words legitimately, and
    // there the giveaway is that the story carries on afterwards.
    const html = `<article>
      <p>The broadcaster said readers could sign up for its new service from Monday.</p>
      <p>The move follows a year in which the station lost a third of its audience to
      rivals, and executives have said the newsletter is central to winning them back
      over the next eighteen months of restructuring.</p>
    </article>`;
    expect(service.cleanBody(html, 'https://example.com/a').text).toContain('sign up for its new service');
  });
});

/**
 * The shape-based rules are blunt by nature, so the other half of the job is
 * showing they leave ordinary journalism alone.
 */
describe('an ordinary article', () => {
  const service = new ExtractionService();

  it('keeps a paragraph that happens to contain a link', () => {
    const html = `<article><p>The report, <a href="https://weforum.org/x">published on Tuesday</a>,
      found that women's sport revenues had tripled since 2022 and would keep climbing.</p></article>`;
    expect(service.cleanBody(html, BASE).text).toContain('tripled since 2022');
  });

  it('keeps a list that is part of the reporting', () => {
    const html = `<article><ul>
      <li>Sports tourism, which the report treats as the largest single driver</li>
      <li>Sport as an asset class, now attracting institutional money</li>
    </ul></article>`;
    expect(service.cleanBody(html, BASE).text).toContain('asset class');
  });

  it('keeps a heading that is not a rail', () => {
    const html = `<article><h3>What does mainstreaming actually mean?</h3>
      <p>The forum argued that women's sport has evolved from a niche category into a
      major economic opportunity worth billions.</p></article>`;
    const text = service.cleanBody(html, BASE).text;
    expect(text).toContain('What does mainstreaming');
    expect(text).toContain('niche category');
  });

  it('keeps a photograph served from an ordinary path', () => {
    const html = `<article><figure><img src="https://cdn.example/2026/08/bulls-lineout.jpg">
      <figcaption>The Bulls contest a lineout</figcaption></figure>
      <p>The lineout was the decisive phase of a match that turned on set pieces.</p></article>`;
    expect(service.cleanBody(html, BASE).images).toHaveLength(1);
  });

  it('does not cut at a subheading that reporting follows', () => {
    // "Related" as a rail heading ends the article; as a subheading it does
    // not, and cutting there would take the rest of the story out of the
    // reader and out of the search index with it.
    const html = `<article>
      <p>The commission heard evidence about procurement failures across three departments.</p>
      <h2>Related developments</h2>
      <p>In a separate matter the same week, the auditor-general reported that a further
      four departments had failed to account for spending running into the billions, and
      said the pattern was now systemic rather than exceptional.</p>
    </article>`;
    const text = service.cleanBody(html, BASE).text;
    expect(text).toContain('auditor-general reported');
    expect(text).toContain('Related developments');
  });

  it('keeps a photograph whose credit icon sits in the same figure', () => {
    // The camera icon is furniture, but it lives inside the figcaption of the
    // figure holding the photograph — taking the figure took the photo too.
    const html = `<article><figure>
      <img src="https://cdn.example/2026/08/hawks-vehicle.jpg">
      <figcaption><img src="https://cdn.example/core/icons/camera.svg"><p>Supplied</p></figcaption>
    </figure><p>The vehicle was photographed outside the committee room on Tuesday morning.</p></article>`;
    const out = service.cleanBody(html, BASE);
    expect(out.images).toHaveLength(1);
    expect(out.images[0].url).toContain('hawks-vehicle');
  });

  it('judges a lazy-loaded image by its real URL, not its placeholder', () => {
    // The placeholder is exactly the kind of path that looks like an asset.
    const html = `<article><figure>
      <img src="https://cdn.example/static/img/placeholder.svg"
           data-src="https://cdn.example/2026/08/bulls-lineout.jpg">
    </figure><p>The lineout was the decisive phase of a match that turned on set pieces.</p></article>`;
    const out = service.cleanBody(html, BASE);
    expect(out.images).toHaveLength(1);
    expect(out.images[0].url).toContain('bulls-lineout');
  });

  it('keeps a single link that is the whole short paragraph', () => {
    // Under 40 characters and one link: could be a real aside, so it stays.
    const html = `<article><p><a href="/x">Read the full judgment</a></p>
      <p>The court found the minister had acted outside the powers granted to him.</p></article>`;
    expect(service.cleanBody(html, BASE).text).toContain('Read the full judgment');
  });
});
