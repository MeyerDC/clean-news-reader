import { describe, expect, it } from 'vitest';

import { splitHeadline } from './headline';

/**
 * Every title here is one a feed actually delivered. The dangerous direction is
 * a false positive: eating "Plum:" or "Damian McKenzie:" would rewrite the
 * story, while missing a kicker only leaves a row looking as it does today.
 */
describe('lifting a kicker out of a headline', () => {
  const kicker = (title: string) => splitHeadline(title).kicker;
  const headline = (title: string) => splitHeadline(title).headline;

  it('lifts a section set in capitals', () => {
    const split = splitHeadline('PARLIAMENT: Gayton McKenzie lashes out at Safa and demands R30m repayment');
    expect(split.kicker).toBe('Parliament');
    expect(split.headline).toBe('Gayton McKenzie lashes out at Safa and demands R30m repayment');
  });

  it('lifts one introduced by a pipe', () => {
    expect(kicker('WATCH | Does stop-start technology really save fuel?')).toBe('Watch');
  });

  it('re-sets the capitals rather than reproducing them', () => {
    // The shouting was the problem; keeping it in a smaller font keeps it.
    expect(kicker("WHAT'S COOKING: Roasted marrow bones in a beef and onion broth")).toBe("What's Cooking");
  });

  it('keeps a name that happens to precede a colon', () => {
    expect(kicker('Plum: Boks’ rush defence now risky')).toBeNull();
    expect(kicker('Damian McKenzie: All Blacks won waiting game of Ellis Park altitude')).toBeNull();
    expect(kicker('Coach Stick: Why Paul de Villiers is \'the right person\' to face All Blacks')).toBeNull();
  });

  it('keeps a sentence that happens to contain a colon', () => {
    expect(kicker('NSFAS applications: What you need to know')).toBeNull();
    expect(kicker('IEC warns parties, candidates: no late submissions after Friday deadline')).toBeNull();
  });

  it('keeps a quotation lead', () => {
    expect(kicker("'We felt the pressure': Cobus Reinach flags All Blacks tactics")).toBeNull();
  });

  it('leaves an all-capitals headline whole', () => {
    // Splitting one would donate the first clause as a kicker and keep
    // shouting the rest, which is worse than doing nothing.
    const title = 'SUPREME COURT BACKS TRUMP PLAN: MIDTERMS MAIL-IN VOTING NOW AT RISK';
    expect(kicker(title)).toBeNull();
    expect(headline(title)).toBe(title);
  });

  it('leaves a long prefix alone', () => {
    const title = 'A VERY LONG SECTION NAME THAT IS REALLY A SENTENCE: and then some more';
    expect(kicker(title)).toBeNull();
  });
});

describe('trailing series branding', () => {
  const headline = (title: string) => splitHeadline(title).headline;

  it('drops the series a piece ran in', () => {
    expect(headline('Wallabies player ratings vs Japan | Flight Centre Series 2026'))
      .toBe('Wallabies player ratings vs Japan');
  });

  it('drops a newsletter name', () => {
    expect(headline('Supreme court threatens midterms mail-in voting as it backs Trump plan | First Thing'))
      .toBe('Supreme court threatens midterms mail-in voting as it backs Trump plan');
  });

  it('does not gut a short title', () => {
    expect(headline('Boks win | Report')).toBe('Boks win | Report');
  });

  it('leaves a trailing clause that carries its own punctuation', () => {
    const title = 'All Blacks player ratings vs Stormers | Was it enough? Probably not';
    expect(headline(title)).toBe(title);
  });

  it('handles both ends at once', () => {
    const split = splitHeadline('WATCH | All Blacks debutant fights back tears | Greatest Rivalry tour');
    expect(split.kicker).toBe('Watch');
    expect(split.headline).toBe('All Blacks debutant fights back tears');
  });
});
