import { Camera, formatCoord, parseBase36, parseDecimal } from "./camera.ts";
import { Input } from "./input.ts";
import { Renderer } from "./renderer.ts";
import { seedFromString } from "./hash.ts";

/**
 * Keeps the render resolution at the highest value that still holds the frame
 * budget. It only ever trusts measured frames: quality drops the moment we miss
 * vsync, and creeps back up under a ceiling that a failed attempt lowers.
 */
class QualityGovernor {
  scale: number;
  private ceiling: number;
  private samples: number[] = [];
  private cooldown = 0;

  /** When pinned, the resolution is held exactly and never adjusted. */
  constructor(private readonly max: number, private readonly pinned: number | null = null) {
    this.scale = pinned ?? Math.min(max, 1.25);
    this.ceiling = max;
  }

  update(dt: number): number {
    if (this.pinned !== null) return this.pinned;
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.samples.push(dt);
    if (this.samples.length < 45) return this.scale;

    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples.length = 0;
    if (this.cooldown > 0) return this.scale;

    if (avg > 0.021) {
      this.ceiling = Math.max(0.45, this.scale * 0.92);
      this.scale = Math.max(0.45, this.scale * 0.85);
      this.cooldown = 1.0;
    } else if (avg < 0.0175) {
      // Comfortably inside budget: let the ceiling heal, then edge back up.
      this.ceiling = Math.min(this.max, this.ceiling * 1.02);
      if (this.scale < this.ceiling - 0.01) {
        this.scale = Math.min(this.ceiling, this.scale * 1.12);
        this.cooldown = 2.0;
      }
    }
    return this.scale;
  }
}

function fail(msg: string, detail = ""): void {
  const box = document.getElementById("error")!;
  document.getElementById("error-msg")!.textContent = msg;
  document.getElementById("error-detail")!.textContent = detail;
  box.classList.add("show");
}

function randomSeed(): bigint {
  const buf = new BigUint64Array(1);
  crypto.getRandomValues(buf);
  return buf[0]!;
}

interface WorldState {
  cx: bigint;
  cy: bigint;
  ox: number;
  oy: number;
  seed: bigint;
  /** Pin the render scale instead of letting the governor tune it. */
  q: number;
  /** Drop the screen-space vignette and grain, leaving the bare field. */
  flat: boolean;
}

function readHash(): Partial<WorldState> {
  const h = location.hash.replace(/^#/, "");
  if (!h) return {};
  const p = new URLSearchParams(h);
  const out: Partial<WorldState> = {};
  const x = p.get("x");
  const y = p.get("y");
  const s = p.get("s");
  if (x) out.cx = parseBase36(x) ?? undefined;
  if (y) out.cy = parseBase36(y) ?? undefined;
  if (s) out.seed = parseBase36(s) ?? undefined;
  const ox = Number(p.get("ox"));
  const oy = Number(p.get("oy"));
  if (Number.isFinite(ox)) out.ox = Math.min(0.999, Math.max(0, ox));
  if (Number.isFinite(oy)) out.oy = Math.min(0.999, Math.max(0, oy));
  if (p.get("flat") === "1") out.flat = true;
  if (p.has("q")) {
    const q = Number(p.get("q"));
    if (Number.isFinite(q) && q > 0) out.q = Math.min(2, Math.max(0.25, q));
  }
  return out;
}

function main(): void {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const saved = readHash();
  const seedRef = { value: saved.seed ?? randomSeed() };

  let renderer: Renderer;
  try {
    renderer = new Renderer(canvas, seedRef.value);
  } catch (err) {
    fail(
      "This needs WebGL2, which this browser or GPU is not offering.",
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const cam = new Camera();
  cam.jumpTo(saved.cx ?? 0n, saved.cy ?? 0n, saved.ox ?? 0.5, saved.oy ?? 0.5);

  let post = !saved.flat;
  renderer.setPost(post);

  const input = new Input(cam, canvas);
  const gov = new QualityGovernor(Math.min(window.devicePixelRatio || 1, 2), saved.q ?? null);

  const elX = document.getElementById("cx")!;
  const elY = document.getElementById("cy")!;
  const elSeed = document.getElementById("cseed")!;
  const elFps = document.getElementById("fps")!;
  const hudEls = Array.from(document.querySelectorAll<HTMLElement>(".hud"));

  function resize(): void {
    renderer.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resize);
  resize();

  function writeHash(): void {
    const p = new URLSearchParams({
      x: cam.cx.toString(36),
      y: cam.cy.toString(36),
      ox: cam.ox.toFixed(3),
      oy: cam.oy.toFixed(3),
      s: seedRef.value.toString(36),
    });
    // A pinned render scale is a deliberate choice; keep it in shared links.
    if (saved.q !== undefined) p.set("q", String(saved.q));
    history.replaceState(null, "", `#${p.toString()}`);
  }

  function updateHud(): void {
    elX.textContent = formatCoord(cam.cx, cam.ox);
    elY.textContent = formatCoord(cam.cy, cam.oy);
    elSeed.textContent = seedRef.value.toString(36).slice(0, 12);
  }

  function reseed(seed: bigint): void {
    seedRef.value = seed;
    renderer.setSeed(seed);
    updateHud();
    writeHash();
  }

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key.toLowerCase()) {
      case "h":
        for (const el of hudEls) el.hidden = !el.hidden;
        break;
      case "f":
        post = !post;
        renderer.setPost(post);
        break;
      case "r":
        reseed(randomSeed());
        break;
      case "0":
        cam.jumpTo(0n, 0n);
        updateHud();
        writeHash();
        break;
      case "g": {
        e.preventDefault();
        const answer = prompt(
          "Go to coordinate — any two integers, however long:",
          `${cam.cx} ${cam.cy}`,
        );
        if (!answer) break;
        const parts = answer.split(/[\s,]+/).filter(Boolean);
        const gx = parts[0] ? parseDecimal(parts[0]) : null;
        const gy = parts[1] ? parseDecimal(parts[1]) : null;
        if (gx === null || gy === null) break;
        cam.jumpTo(gx, gy);
        updateHud();
        writeHash();
        break;
      }
      case "n": {
        const word = prompt("Seed this world with a word:", "");
        if (word) reseed(seedFromString(word));
        break;
      }
    }
  });

  let last = performance.now();
  let hudClock = 0;
  let hashClock = 0;
  let frames = 0;
  let fpsClock = 0;

  function frame(now: number): void {
    // Clamp so a backgrounded tab does not fling the camera on return.
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    input.update(dt);
    renderer.setScale(gov.update(dt));
    renderer.render(cam);

    frames++;
    fpsClock += dt;
    if (fpsClock >= 0.5) {
      elFps.textContent = `${Math.round(frames / fpsClock)} fps · ${Math.round(renderer.scale * 100)}%`;
      frames = 0;
      fpsClock = 0;
    }

    if (input.moved) {
      hudClock += dt;
      hashClock += dt;
      if (hudClock > 0.06) {
        updateHud();
        hudClock = 0;
      }
      if (hashClock > 0.5) {
        writeHash();
        hashClock = 0;
        input.moved = false;
      }
    }

    requestAnimationFrame(frame);
  }

  updateHud();
  writeHash();
  requestAnimationFrame(frame);
}

main();
