import { describe, expect, it } from 'vitest';
import { REDACTED, redact, scrubString } from './redaction.js';

describe('redact', () => {
  it('removes secrets by field name regardless of casing or separators', () => {
    const result = redact({
      email: 'dana@northstar.example',
      password: 'correct horse battery staple',
      passwordHash: '$argon2id$v=19$...',
      API_KEY: 'atlas_live_abc123def456',
      'session-token': 'abc',
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
    }) as Record<string, unknown>;

    expect(result.email).toBe('dana@northstar.example');
    for (const key of ['password', 'passwordHash', 'API_KEY', 'session-token', 'Authorization']) {
      expect(result[key], key).toBe(REDACTED);
    }
  });

  it('reaches secrets nested inside objects and arrays', () => {
    const result = redact({
      request: { body: { user: { password: 'hunter2' } } },
      keys: [{ keyHash: 'deadbeef' }, { name: 'CI deploy' }],
    }) as Record<string, never>;

    expect(
      (result as never as { request: { body: { user: { password: string } } } }).request.body.user
        .password,
    ).toBe(REDACTED);
    expect(
      (result as never as { keys: Array<{ keyHash?: string; name?: string }> }).keys[0]?.keyHash,
    ).toBe(REDACTED);
    expect(
      (result as never as { keys: Array<{ keyHash?: string; name?: string }> }).keys[1]?.name,
    ).toBe('CI deploy');
  });

  it('catches a raw API key that leaked into a message value', () => {
    // The dangerous case is not the field we remembered to name — it is a key
    // echoed into an error string by something we did not control.
    const result = redact({
      message: 'Request failed with header x-api-key: atlas_live_9f2b7c1d4e6a8b0c',
    }) as { message: string };

    expect(result.message).not.toContain('atlas_live_9f2b7c1d4e6a8b0c');
    expect(result.message).toContain(REDACTED);
  });

  it('scrubs bearer tokens embedded in free text', () => {
    const scrubbed = scrubString('failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef');
    expect(scrubbed).not.toContain('eyJhbGciOiJIUzI1NiJ9abcdef');
    expect(scrubbed).toContain('Bearer [redacted]');
  });

  it('preserves error shape while scrubbing message and stack', () => {
    const error = new Error('token atlas_live_aaaabbbbccccdddd rejected');
    const result = redact(error) as { name: string; message: string };
    expect(result.name).toBe('Error');
    expect(result.message).not.toContain('atlas_live_aaaabbbbccccdddd');
  });

  it('does not mutate the input', () => {
    // The object being logged is usually still in use by the request that
    // produced it; redacting in place would blank a value the app still needs.
    const input = { password: 'hunter2', nested: { token: 'abc' } };
    redact(input);
    expect(input.password).toBe('hunter2');
    expect(input.nested.token).toBe('abc');
  });

  it('terminates on deeply nested and cyclic structures', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    expect(() => redact(cyclic)).not.toThrow();

    let deep: Record<string, unknown> = { value: 'leaf' };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    expect(() => redact(deep)).not.toThrow();
  });

  it('leaves primitives and non-sensitive data untouched', () => {
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
    expect(redact(true)).toBe(true);
    expect(redact({ organizationId: 'org-1', count: 3 })).toEqual({
      organizationId: 'org-1',
      count: 3,
    });
  });
});
