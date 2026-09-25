import { hash, verify } from "@node-rs/argon2";

/**
 * `Algorithm.Argon2id` from @node-rs/argon2 is an ambient const enum, which
 * `isolatedModules` forbids importing. Its value is 2; inlining it keeps the
 * algorithm explicit rather than relying on the library's default.
 */
const ARGON2ID = 2;

/**
 * Argon2id parameters. 19 MiB of memory with 2 passes is the OWASP baseline
 * recommendation and stays under ~50 ms on the kind of small instance a single
 * clinic deployment runs on.
 *
 * The cost parameters are embedded in the resulting hash string, so raising
 * them later does not invalidate existing hashes — `needsRehash` detects the
 * old ones and the login path upgrades them transparently.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Constant-time verification. Returns false rather than throwing on a malformed
 * stored hash so a corrupt row cannot be distinguished from a wrong password.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/** True when a stored hash predates the current cost parameters. */
export function needsRehash(storedHash: string): boolean {
  const memoryMatch = /\bm=(\d+)/.exec(storedHash);
  const timeMatch = /\bt=(\d+)/.exec(storedHash);
  if (!storedHash.startsWith("$argon2id$")) return true;
  if (!memoryMatch || !timeMatch) return true;
  return (
    Number(memoryMatch[1]) < ARGON2_OPTIONS.memoryCost || Number(timeMatch[1]) < ARGON2_OPTIONS.timeCost
  );
}

/**
 * A pre-computed hash of a random value, verified when an email does not exist.
 * Without it, a missing account returns noticeably faster than a wrong
 * password and the login endpoint becomes an account-enumeration oracle.
 */
let dummyHashPromise: Promise<string> | undefined;
export async function burnPasswordVerification(): Promise<void> {
  dummyHashPromise ??= hashPassword("timing-equalizer-not-a-real-password");
  await verifyPassword(await dummyHashPromise, "wrong");
}
