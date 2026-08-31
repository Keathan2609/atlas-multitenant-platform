import { describe, expect, it } from 'vitest';
import {
  displayNameSchema,
  emailSchema,
  passwordSchema,
  projectKeySchema,
  slugSchema,
  slugify,
} from './primitives.js';

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);

describe('emailSchema', () => {
  it('normalises case and whitespace so one account cannot be created twice', () => {
    // The database unique index is on the stored value, so normalisation has to
    // happen in validation. Otherwise "Alice@Example.com" and
    // "alice@example.com" become two accounts claiming the same inbox.
    expect(emailSchema.parse('  Alice@Example.COM ')).toBe('alice@example.com');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['not-an-email', 'a@', '@b.com', 'a b@c.com', '']) {
      expect(emailSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('passwordSchema', () => {
  it('requires length rather than composition', () => {
    // A long passphrase must pass even with no digits or symbols — composition
    // rules push users toward predictable patterns (NIST SP 800-63B).
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
    expect(passwordSchema.safeParse('Sh0rt!').success).toBe(false);
  });

  it('caps length at the bcrypt-family byte limit', () => {
    expect(passwordSchema.safeParse('a'.repeat(72)).success).toBe(true);
    expect(passwordSchema.safeParse('a'.repeat(73)).success).toBe(false);
  });
});

describe('slugSchema — URL safety boundary', () => {
  it('accepts well-formed slugs', () => {
    for (const good of ['northstar', 'meridian-labs', 'team-42', 'a1']) {
      expect(slugSchema.safeParse(good).success, good).toBe(true);
    }
  });

  it('rejects path traversal and URL metacharacters', () => {
    // Slugs are interpolated into /app/{slug}/projects. Anything that can
    // change the shape of that path is a routing and access-control problem,
    // not a formatting nit.
    const attacks = [
      '..',
      '../admin',
      'a/b',
      'a%2Fb',
      'a.b',
      'a?b',
      'a#b',
      'a b',
      '-leading',
      'trailing-',
      'double--hyphen',
    ];
    for (const attack of attacks) {
      expect(slugSchema.safeParse(attack).success, attack).toBe(false);
    }
  });

  it('normalises case and surrounding whitespace instead of rejecting it', () => {
    // Accepting "Northstar" and storing "northstar" is deliberate: it matches
    // how GitHub and Stripe treat org handles, and the stored value is what
    // both the unique index and the URL see.
    expect(slugSchema.parse('  Northstar  ')).toBe('northstar');
  });

  it('strips a trailing newline rather than letting it reach the URL', () => {
    // JavaScript's `$` matches before a final newline, so the pattern alone
    // would accept a trailing LF. `.trim()` runs first and removes it, so the
    // value reaching the regex — and the URL — is already clean.
    expect(slugSchema.parse(`acme${LF}`)).toBe('acme');
    expect(slugSchema.parse(`acme${CR}${LF}`)).toBe('acme');
  });

  it('rejects an interior line break', () => {
    // Trim cannot help here. This is what the pattern and the explicit
    // line-break guard actually defend against.
    expect(slugSchema.safeParse(`ac${LF}me`).success).toBe(false);
    expect(slugSchema.safeParse(`ac${CR}me`).success).toBe(false);
  });

  it('rejects reserved slugs that would shadow application routes', () => {
    for (const reserved of ['api', 'admin', 'settings', 'login', 'new']) {
      expect(slugSchema.safeParse(reserved).success, reserved).toBe(false);
    }
  });
});

describe('slugify', () => {
  it('folds accents to ASCII rather than percent-encoding them', () => {
    expect(slugify('Café Meridian')).toBe('cafe-meridian');
    expect(slugify('Ünïcode Tëst')).toBe('unicode-test');
  });

  it('collapses punctuation and trims separators', () => {
    expect(slugify('  Northstar   Systems!! ')).toBe('northstar-systems');
    expect(slugify('A//B..C')).toBe('a-b-c');
  });

  it('produces output the slug schema accepts', () => {
    for (const name of ['Northstar Systems', 'Meridian Labs', 'Platform & Infra']) {
      const candidate = slugify(name);
      expect(slugSchema.safeParse(candidate).success, `${name} -> ${candidate}`).toBe(true);
    }
  });

  it('never emits a trailing hyphen after truncation', () => {
    // Truncating at 64 chars can land mid-separator; the schema would then
    // reject a slug the application generated itself.
    const long = `${'word '.repeat(40)}end`;
    const candidate = slugify(long);
    expect(candidate.endsWith('-')).toBe(false);
    expect(slugSchema.safeParse(candidate).success).toBe(true);
  });
});

describe('projectKeySchema', () => {
  it('uppercases and requires a leading letter', () => {
    expect(projectKeySchema.parse('portal')).toBe('PORTAL');
    expect(projectKeySchema.safeParse('1ABC').success).toBe(false);
    expect(projectKeySchema.safeParse('AB-C').success).toBe(false);
  });
});

describe('displayNameSchema', () => {
  it('rejects control characters used to spoof names in member lists', () => {
    // Built from char codes rather than pasted, so the intent survives any
    // editor or transport that would silently strip an invisible byte.
    const NUL = String.fromCharCode(0);
    const BELL = String.fromCharCode(7);
    const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);

    expect(displayNameSchema.safeParse('Dana Whitfield').success).toBe(true);
    expect(displayNameSchema.safeParse(`Dana${NUL} Whitfield`).success).toBe(false);
    expect(displayNameSchema.safeParse(`Dana${BELL}Whitfield`).success).toBe(false);

    // Zero-width joiner sits above the control range and is deliberately
    // allowed: it appears in legitimate names and emoji sequences.
    expect(displayNameSchema.safeParse(`Dana${ZERO_WIDTH_JOINER}Whitfield`).success).toBe(true);
  });

  it('requires a non-empty name after trimming', () => {
    expect(displayNameSchema.safeParse('   ').success).toBe(false);
    expect(displayNameSchema.parse('  Dana Whitfield  ')).toBe('Dana Whitfield');
  });
});
