import { CELL_PX, type Camera } from "./camera.ts";
import { mix32, split32 } from "./hash.ts";
import { LatticePyramid } from "./lattice.ts";
import { FRAGMENT_SRC, VERTEX_SRC } from "./shaders.ts";

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("could not create shader");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? "unknown error";
    gl.deleteShader(sh);
    throw new Error(`shader compile failed:\n${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error("could not create program");
  const v = compile(gl, gl.VERTEX_SHADER, vs);
  const f = compile(gl, gl.FRAGMENT_SHADER, fs);
  gl.attachShader(prog, v);
  gl.attachShader(prog, f);
  gl.linkProgram(prog);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? "unknown error";
    gl.deleteProgram(prog);
    throw new Error(`program link failed:\n${log}`);
  }
  return prog;
}

/** A cosine palette (a + b*cos(2pi(c*t+d))) whose character is fixed by the world seed. */
function paletteFor(seed: bigint): { a: number[]; b: number[]; c: number[]; d: number[] } {
  const [lo, hi] = split32(seed);
  let s = lo ^ 0x5bf03635;
  const rand = (): number => {
    s = mix32(s ^ hi);
    return s / 0x100000000;
  };
  const base = 0.46 + rand() * 0.12;
  const a = [base, base + (rand() - 0.5) * 0.08, base + (rand() - 0.5) * 0.08];
  // Modest amplitudes: large ones drive channels to full saturation and every
  // seed ends up looking like the same neon.
  const b = [0.17 + rand() * 0.13, 0.17 + rand() * 0.13, 0.17 + rand() * 0.13];
  // Frequencies near 1 stop the palette from strobing across the height range.
  const c = [0.94 + rand() * 0.14, 0.94 + rand() * 0.14, 0.94 + rand() * 0.14];
  // Phase is what makes a hue. Independent random phases cluster often enough
  // that the channels move together and the whole world comes out grey, so the
  // spread between them is enforced -- wide enough to separate, narrow enough
  // to stay a duotone rather than a rainbow.
  const d0 = rand();
  const d = [d0, d0 + 0.1 + rand() * 0.19, d0 + 0.22 + rand() * 0.3];
  return { a, b, c, d };
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly lattice: LatticePyramid;
  /** Fraction of native device resolution to render at; tuned automatically. */
  scale = 1;

  private readonly canvas: HTMLCanvasElement;
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly loc: Record<string, WebGLUniformLocation | null>;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(canvas: HTMLCanvasElement, seed: bigint) {
    this.canvas = canvas;
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
      desynchronized: true,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser");
    this.gl = gl;

    this.program = link(gl, VERTEX_SRC, FRAGMENT_SRC);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("could not create vertex array");
    this.vao = vao;

    const u = (name: string) => gl.getUniformLocation(this.program, name);
    this.loc = {
      lat: u("uLat"),
      modBase: u("uModBase[0]"),
      camOff: u("uCamOff"),
      res: u("uRes"),
      cellPx: u("uCellPx"),
      bands: u("uBands"),
      post: u("uPost"),
      palA: u("uPalA"),
      palB: u("uPalB"),
      palC: u("uPalC"),
      palD: u("uPalD"),
    };

    this.lattice = new LatticePyramid(gl, seed);
    gl.useProgram(this.program);
    gl.uniform1i(this.loc.lat!, 0);
    gl.uniform1f(this.loc.bands!, 9.0);
    gl.uniform1f(this.loc.post!, 1.0);
    this.applyPalette(seed);
  }

  /** Screen-space vignette and grain, 1 on or 0 off. Off gives the raw field. */
  setPost(on: boolean): void {
    this.gl.useProgram(this.program);
    this.gl.uniform1f(this.loc.post!, on ? 1.0 : 0.0);
  }

  setSeed(seed: bigint): void {
    this.lattice.setSeed(seed);
    this.gl.useProgram(this.program);
    this.applyPalette(seed);
  }

  private applyPalette(seed: bigint): void {
    const p = paletteFor(seed);
    const gl = this.gl;
    gl.uniform3f(this.loc.palA!, p.a[0]!, p.a[1]!, p.a[2]!);
    gl.uniform3f(this.loc.palB!, p.b[0]!, p.b[1]!, p.b[2]!);
    gl.uniform3f(this.loc.palC!, p.c[0]!, p.c[1]!, p.c[2]!);
    gl.uniform3f(this.loc.palD!, p.d[0]!, p.d[1]!, p.d[2]!);
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.applySize();
  }

  setScale(scale: number): void {
    if (Math.abs(scale - this.scale) < 0.01) return;
    this.scale = scale;
    this.applySize();
  }

  private applySize(): void {
    const w = Math.max(1, Math.round(this.cssWidth * this.scale));
    const h = Math.max(1, Math.round(this.cssHeight * this.scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  render(cam: Camera): void {
    const gl = this.gl;
    this.lattice.update(cam);

    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.lattice.texture);

    gl.uniform2fv(this.loc.modBase!, this.lattice.modBase);
    gl.uniform2f(this.loc.camOff!, cam.ox, cam.oy);
    gl.uniform2f(this.loc.res!, this.canvas.width, this.canvas.height);
    // Scaling the cell size with the render scale keeps the world the same
    // size on screen no matter what resolution we are rendering at.
    gl.uniform1f(this.loc.cellPx!, CELL_PX * this.scale);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}
