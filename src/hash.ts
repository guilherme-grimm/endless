/**
 * Exact hashing for unbounded integer coordinates.
 *
 * The world is addressed by arbitrary-precision integers, so hashing has to
 * survive coordinates with hundreds of digits. The trick that keeps this cheap
 * is separability: we fold each axis independently (the expensive BigInt part,
 * done once per row and column) and then combine the folded pairs with plain
 * 32-bit integer math (the part done once per lattice point).
 *
 * For a 40x40 lattice that is 80 BigInt folds instead of 1600.
 */

const M64 = (1n << 64n) - 1n;

function splitmix64(z: bigint): bigint {
  z = (z + 0x9e3779b97f4a7c15n) & M64;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
  return (z ^ (z >> 31n)) & M64;
}

/**
 * Collapse an arbitrary-precision integer into 64 bits, consuming every limb so
 * that distinct coordinates stay distinct no matter how large they get. Normal
 * coordinates (under 2^64) cost a single round.
 */
export function fold64(v: bigint): bigint {
  // Zigzag so negatives map onto positives without losing the sign bit.
  let x = v < 0n ? -2n * v - 1n : 2n * v;
  let h = 0xcbf29ce484222325n;
  do {
    h = splitmix64(h ^ (x & M64));
    x >>= 64n;
  } while (x > 0n);
  return h;
}

/** Split a folded 64-bit value into two unsigned 32-bit halves. */
export function split32(h: bigint): [number, number] {
  return [Number(h & 0xffffffffn) >>> 0, Number((h >> 32n) & 0xffffffffn) >>> 0];
}

/** Avalanche finalizer for 32-bit values (lowbias32). */
export function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * Combine two folded axis hashes plus a level and world seed into two
 * independent 32-bit hashes. Pure integer math, no allocation.
 */
export function combine(
  xLo: number,
  xHi: number,
  yLo: number,
  yHi: number,
  level: number,
  seedLo: number,
  seedHi: number,
): [number, number] {
  let a = mix32(xLo ^ 0x9e3779b9);
  a = mix32(a ^ xHi);
  a = mix32(a ^ yLo);
  a = mix32(a ^ yHi);
  a = mix32(a ^ Math.imul(level + 1, 0x85ebca6b));
  a = mix32(a ^ seedLo);
  const b = mix32(a ^ seedHi ^ 0x27d4eb2f);
  return [a, b];
}

/** Derive a 64-bit world seed from a human-typed string. */
export function seedFromString(s: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i++) {
    h = splitmix64(h ^ BigInt(s.charCodeAt(i)));
  }
  return h;
}
