/**
 * A camera on an unbounded 2D plane.
 *
 * Position is split into an exact integer cell coordinate (BigInt, unbounded)
 * and a fractional offset within that cell (float, always in [0,1)). Because
 * the float half never grows beyond 1, precision is identical at the origin and
 * at 10^500 -- there is no drift, no jitter, and no far-away region where the
 * world starts to shimmer.
 */

/**
 * Side of the finest lattice cell, in CSS pixels. Fixed, so the world looks the
 * same on every display. This sets the whole scale pyramid: level k has cells
 * 2^k times this, and the octaves that carry the visible structure need to
 * straddle the viewport rather than tower over it.
 */
export const CELL_PX = 48;

export class Camera {
  cx = 0n;
  cy = 0n;
  /** Fractional position inside the current cell, in [0,1). */
  ox = 0;
  oy = 0;
  /** Velocity in cells per second. */
  vx = 0;
  vy = 0;

  /** Move by a pixel delta (screen space). */
  panPixels(dx: number, dy: number): void {
    this.ox += dx / CELL_PX;
    this.oy += dy / CELL_PX;
    this.normalize();
  }

  /** Move by a cell delta. */
  pan(dx: number, dy: number): void {
    this.ox += dx;
    this.oy += dy;
    this.normalize();
  }

  /** Carry any whole-cell part of the offset into the exact integer coordinate. */
  normalize(): void {
    const fx = Math.floor(this.ox);
    if (fx !== 0) {
      this.cx += BigInt(fx);
      this.ox -= fx;
    }
    const fy = Math.floor(this.oy);
    if (fy !== 0) {
      this.cy += BigInt(fy);
      this.oy -= fy;
    }
  }

  /** Apply velocity and exponential drag for one frame. */
  integrate(dt: number, drag: number): void {
    if (this.vx === 0 && this.vy === 0) return;
    this.pan(this.vx * dt, this.vy * dt);
    const k = Math.exp(-drag * dt);
    this.vx *= k;
    this.vy *= k;
    if (Math.abs(this.vx) < 1e-4) this.vx = 0;
    if (Math.abs(this.vy) < 1e-4) this.vy = 0;
  }

  jumpTo(cx: bigint, cy: bigint, ox = 0.5, oy = 0.5): void {
    this.cx = cx;
    this.cy = cy;
    this.ox = ox;
    this.oy = oy;
    this.vx = 0;
    this.vy = 0;
    this.normalize();
  }

  isMoving(): boolean {
    return this.vx !== 0 || this.vy !== 0;
  }
}

/** Parse a base-36 string (with optional leading '-') into a BigInt. */
export function parseBase36(s: string): bigint | null {
  const t = s.trim().toLowerCase();
  const neg = t.startsWith("-");
  const body = neg ? t.slice(1) : t;
  if (body.length === 0 || !/^[0-9a-z]+$/.test(body)) return null;
  let v = 0n;
  for (const ch of body) {
    const d = ch <= "9" ? ch.charCodeAt(0) - 48 : ch.charCodeAt(0) - 87;
    v = v * 36n + BigInt(d);
  }
  return neg ? -v : v;
}

/** Parse a decimal integer string of any length into a BigInt. */
export function parseDecimal(s: string): bigint | null {
  const t = s.trim().replace(/[_\s,]/g, "");
  if (!/^-?\d+$/.test(t)) return null;
  return BigInt(t);
}

/**
 * Render an unbounded coordinate for human eyes: exact when it is short enough
 * to read, scientific notation once it stops being meaningful digit by digit.
 */
export function formatCoord(v: bigint, frac: number): string {
  const s = v.toString();
  const neg = s.startsWith("-");
  const digits = neg ? s.slice(1) : s;
  const sign = neg ? "-" : "";
  if (digits.length <= 15) {
    const cents = Math.floor(frac * 100)
      .toString()
      .padStart(2, "0");
    return `${sign}${digits}.${cents}`;
  }
  const head = digits[0];
  const tail = digits.slice(1, 5);
  return `${sign}${head}.${tail}e+${digits.length - 1}`;
}
