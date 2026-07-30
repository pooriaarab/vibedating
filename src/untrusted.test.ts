import { describe, expect, it } from 'vitest';
import { MAX_TEXT_LEN } from './frame.js';
import { MAX_DISPLAY_TEXT_LEN, sanitizePeerText } from './untrusted.js';

describe('sanitizePeerText() — input-safety untrusted display data', () => {
  it('passes ordinary text through untouched', () => {
    expect(sanitizePeerText('hey, nice league!')).toBe('hey, nice league!');
    expect(sanitizePeerText('caf\u00e9 \u00fcber')).toBe('caf\u00e9 \u00fcber');
  });

  it('strips terminal escape / CSI sequences (ESC, and C1 CSI)', () => {
    expect(sanitizePeerText('\u001b[31mred\u001b[0m')).toBe('[31mred[0m');
    expect(sanitizePeerText('\u009b7mhi\u009b0m')).toBe('7mhi0m');
  });

  it('strips CR and other C0 controls but keeps \n and \t', () => {
    expect(sanitizePeerText('line1\rline2')).toBe('line1line2');
    expect(sanitizePeerText('a\u0007b\u0000c')).toBe('abc');
    expect(sanitizePeerText('multi\nline\ttext')).toBe('multi\nline\ttext');
  });

  it('strips bidi spoofing chars and BOM, keeps ZWJ emoji', () => {
    expect(sanitizePeerText('\u202e reversed \u202c')).toBe(' reversed ');
    expect(sanitizePeerText('\u2066iso\u2069')).toBe('iso');
    expect(sanitizePeerText('\u200e\u200f\ufeffplain')).toBe('plain');
    // ZWJ (\u200d) is kept so emoji sequences survive.
    expect(sanitizePeerText('\u2764\ufe0f\u200d\ud83d\udd25')).toBe(
      '\u2764\ufe0f\u200d\ud83d\udd25',
    );
  });

  it('caps length (default = the wire cap)', () => {
    expect(MAX_DISPLAY_TEXT_LEN).toBe(MAX_TEXT_LEN);
    const long = 'x'.repeat(MAX_TEXT_LEN + 500);
    const got = sanitizePeerText(long);
    expect(got.length).toBe(MAX_TEXT_LEN);
    expect(sanitizePeerText('aaaaaaaaaa', 4)).toBe('aaaa');
  });
});
