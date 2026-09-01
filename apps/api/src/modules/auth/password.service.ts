import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

/**
 * Password hashing.
 *
 * Argon2id, which is the current OWASP first choice for password storage. It
 * is memory-hard, so an attacker with GPUs or ASICs gains far less advantage
 * than against bcrypt or PBKDF2.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet's Argon2id
 * recommendation (19 MiB memory, 2 iterations, parallelism 1). Raising
 * `memoryCost` is the most effective lever if hardware allows; changing these
 * values does not invalidate existing hashes, because Argon2 encodes its
 * parameters in the hash string itself and `needsRehash` below detects the
 * difference on next login.
 */
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * A real Argon2id hash of a value nobody knows, computed once at module load.
 *
 * Used to burn equivalent CPU when a login names an account that does not
 * exist. Without it, "no such user" returns in microseconds while a real
 * account takes ~50ms, and that timing difference is a reliable account
 * enumeration oracle regardless of how carefully the error messages are
 * worded. See docs/security.md § user enumeration.
 */
let dummyHashPromise: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash('atlas-timing-equaliser-not-a-real-password', ARGON2_OPTIONS);
  return dummyHashPromise;
}

@Injectable()
export class PasswordService {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2_OPTIONS);
  }

  /**
   * Verifies a password against a stored hash.
   *
   * Returns false rather than throwing on a malformed hash: a corrupt row
   * should deny access, not produce a 500 that tells the caller the row exists.
   */
  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      return false;
    }
  }

  /**
   * Burns the same CPU as a real verification, then fails.
   *
   * Call this on the "user not found" branch of login so the response time is
   * indistinguishable from a wrong password against a real account.
   */
  async verifyDummy(plaintext: string): Promise<false> {
    const hash = await getDummyHash();
    try {
      await argon2.verify(hash, plaintext);
    } catch {
      // Expected — the point is the work, not the result.
    }
    return false;
  }

  /**
   * True when a stored hash was produced with weaker parameters than current
   * policy. Login rehashes transparently when this returns true, so the
   * population migrates to stronger settings without a forced reset.
   */
  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, ARGON2_OPTIONS);
    } catch {
      // Unparseable hash — treat as needing replacement.
      return true;
    }
  }
}
