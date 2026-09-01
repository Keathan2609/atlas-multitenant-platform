import { describe, expect, it } from 'vitest';
import { PasswordService } from './password.service.js';

const passwords = new PasswordService();

describe('PasswordService', () => {
  it('produces an Argon2id hash, not bcrypt or a bare digest', async () => {
    const hash = await passwords.hash('correct horse battery staple');

    // The prefix encodes the algorithm and its parameters. Asserting on it
    // means a change of algorithm or a weakening of parameters is a test
    // failure rather than a silent downgrade.
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('produces a different hash each time for the same password', async () => {
    // Argon2 salts internally. Identical hashes would mean a missing salt,
    // which makes the whole table rainbow-table-able at once.
    const [a, b] = await Promise.all([passwords.hash('same password here'), passwords.hash('same password here')]);
    expect(a).not.toBe(b);
  });

  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    await expect(passwords.verify(hash, 'correct horse battery staple')).resolves.toBe(true);
    await expect(passwords.verify(hash, 'correct horse battery stapl')).resolves.toBe(false);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A corrupt row must deny access, not produce a 500 — a 500 here would
    // itself confirm to the caller that the account row exists.
    await expect(passwords.verify('not-a-hash', 'anything')).resolves.toBe(false);
    await expect(passwords.verify('', 'anything')).resolves.toBe(false);
  });

  it('burns comparable time on the dummy path as on a real verification', async () => {
    // This is what makes "unknown account" indistinguishable from "wrong
    // password" by timing. If verifyDummy ever short-circuits, login becomes
    // an account-enumeration oracle regardless of the error message.
    const hash = await passwords.hash('correct horse battery staple');

    const timeIt = async (fn: () => Promise<unknown>): Promise<number> => {
      const started = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - started) / 1e6;
    };

    const realMs = await timeIt(() => passwords.verify(hash, 'wrong password entirely'));
    const dummyMs = await timeIt(() => passwords.verifyDummy('wrong password entirely'));

    const ratio = Math.max(realMs, dummyMs) / Math.max(1, Math.min(realMs, dummyMs));
    expect(ratio).toBeLessThan(3);
  });

  it('always resolves false from the dummy path', async () => {
    await expect(passwords.verifyDummy('anything at all')).resolves.toBe(false);
  });

  it('does not ask to rehash a hash written at current parameters', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    expect(passwords.needsRehash(hash)).toBe(false);
  });

  it('asks to rehash a weaker hash and an unparseable one', () => {
    // A hash produced with lower memory/time cost must be upgraded on next
    // login rather than left at the old strength forever.
    const weak = '$argon2id$v=19$m=4096,t=1,p=1$c29tZXNhbHR2YWx1ZQ$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYQ';
    expect(passwords.needsRehash(weak)).toBe(true);
    expect(passwords.needsRehash('garbage')).toBe(true);
  });
});
