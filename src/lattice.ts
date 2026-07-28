/**
 * The hash pyramid: the bridge between unbounded CPU coordinates and the
 * shader's float32 world.
 *
 * Each level k is a noise lattice whose cells are 2^k world cells across. For
 * every level we keep a TEX x TEX window of lattice points centred on the
 * camera, hashed exactly on the CPU and uploaded as one layer of a float
 * texture array. The shader never learns an absolute coordinate; it reads
 * gradients out of this window using small local indices.
 *
 * Because the chunk grid *is* the noise lattice, interpolation across a chunk
 * boundary is just ordinary noise interpolation. Seams are structurally
 * impossible rather than something that has to be hidden.
 *
 * A level is only rebuilt when the camera crosses one of *its* cell boundaries,
 * so the fine levels (which move constantly) are cheap and the coarse levels
 * (which are large) almost never touch the bus.
 */

import { combine, fold64, split32 } from "./hash.ts";
import type { Camera } from "./camera.ts";

/**
 * Number of octaves. Level 0 is the finest (CELL_PX across); level LEVELS-1
 * spans 2^(LEVELS-1) cells and drives slow regional character.
 */
export const LEVELS = 12;
/**
 * Width of the lattice window kept per level, in lattice points. This has to
 * cover the viewport at level 0 *plus* the domain warp displacement, since a
 * warped sample reaches outside the unwarped footprint. At 4K that is about
 * 24 cells of viewport and 6 of warp, well inside the 56 available here.
 */
export const TEX = 128;
/** Lattice index 0 sits at this texel, so indices run -HALF .. HALF-1. */
export const HALF = TEX / 2;

/** Each lattice point stores two independent unit gradients: xy and zw. */
const COMPONENTS = 4;

export class LatticePyramid {
  readonly texture: WebGLTexture;
  /** (cx mod 2^k, cy mod 2^k) per level, normalised into the shader's units. */
  readonly modBase = new Float32Array(LEVELS * 2);

  private readonly gl: WebGL2RenderingContext;
  private readonly buf = new Float32Array(TEX * TEX * COMPONENTS);
  private readonly rowLo = new Uint32Array(TEX);
  private readonly rowHi = new Uint32Array(TEX);
  private readonly colLo = new Uint32Array(TEX);
  private readonly colHi = new Uint32Array(TEX);
  private readonly baseX: (bigint | null)[] = new Array(LEVELS).fill(null);
  private readonly baseY: (bigint | null)[] = new Array(LEVELS).fill(null);
  private seedLo = 0;
  private seedHi = 0;

  constructor(gl: WebGL2RenderingContext, seed: bigint) {
    this.gl = gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error("could not allocate lattice texture");
    this.texture = tex;

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, TEX, TEX, LEVELS);
    // Interpolation happens in the shader, so point sampling is all we need --
    // which also means no float-linear extension is required.
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    this.setSeed(seed);
  }

  setSeed(seed: bigint): void {
    const [lo, hi] = split32(seed);
    this.seedLo = lo;
    this.seedHi = hi;
    this.baseX.fill(null);
    this.baseY.fill(null);
  }

  /**
   * Bring every level in line with the camera. Returns how many levels were
   * rebuilt, which is a useful thing to watch while tuning.
   */
  update(cam: Camera): number {
    let rebuilt = 0;
    for (let k = 0; k < LEVELS; k++) {
      const shift = BigInt(k);
      const bx = cam.cx >> shift;
      const by = cam.cy >> shift;

      // BigInt >> is an arithmetic shift, i.e. floor division, so the remainder
      // below is always in [0, 2^k) even for negative coordinates.
      const span = 2 ** k;
      this.modBase[k * 2] = Number(cam.cx - (bx << shift)) / span;
      this.modBase[k * 2 + 1] = Number(cam.cy - (by << shift)) / span;

      if (this.baseX[k] === bx && this.baseY[k] === by) continue;
      this.baseX[k] = bx;
      this.baseY[k] = by;
      this.rebuildLevel(k, bx, by);
      rebuilt++;
    }
    return rebuilt;
  }

  /** Hash one level's window and upload it. */
  private rebuildLevel(level: number, bx: bigint, by: bigint): void {
    const { rowLo, rowHi, colLo, colHi, buf } = this;

    // The expensive arbitrary-precision work: once per row and column, not once
    // per lattice point.
    for (let i = 0; i < TEX; i++) {
      const d = BigInt(i - HALF);
      const [xl, xh] = split32(fold64(bx + d));
      rowLo[i] = xl;
      rowHi[i] = xh;
      const [yl, yh] = split32(fold64(by + d));
      colLo[i] = yl;
      colHi[i] = yh;
    }

    // The cheap part: plain 32-bit mixing per lattice point.
    const TAU = Math.PI * 2;
    let p = 0;
    for (let j = 0; j < TEX; j++) {
      const yl = colLo[j]!;
      const yh = colHi[j]!;
      for (let i = 0; i < TEX; i++) {
        const [h1, h2] = combine(rowLo[i]!, rowHi[i]!, yl, yh, level, this.seedLo, this.seedHi);
        const a1 = (h1 & 0xffff) * (TAU / 0x10000);
        const a2 = (h2 & 0xffff) * (TAU / 0x10000);
        buf[p] = Math.cos(a1);
        buf[p + 1] = Math.sin(a1);
        buf[p + 2] = Math.cos(a2);
        buf[p + 3] = Math.sin(a2);
        p += COMPONENTS;
      }
    }

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.texture);
    gl.texSubImage3D(
      gl.TEXTURE_2D_ARRAY, 0,
      0, 0, level,
      TEX, TEX, 1,
      gl.RGBA, gl.FLOAT, buf,
    );
  }

  dispose(): void {
    this.gl.deleteTexture(this.texture);
  }
}
