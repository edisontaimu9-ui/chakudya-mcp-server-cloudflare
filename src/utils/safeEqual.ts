/**
 * Constant-time string comparison for secrets (bearer tokens, refresh tokens).
 *
 * A plain `===` returns at the first differing character, so response timing can
 * leak how much of a guess was right. This always walks the longer of the two
 * strings and folds the length difference into the result, so timing doesn't
 * depend on where (or whether) the strings differ. Synchronous on purpose so it
 * works inside requireAuth() without making it async.
 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++) {
    diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  }
  return diff === 0;
}
