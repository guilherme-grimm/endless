import { CELL_PX, type Camera } from "./camera.ts";

// Expressed in pixels so they stay meaningful if the lattice scale is retuned.
const KEY_ACCEL = 7000 / CELL_PX; // cells per second squared
const KEY_MAX = 2400 / CELL_PX; // cells per second
const DRAG = 3.4; // exponential velocity decay, per second

/** Wheel deltas arrive in pixels, lines or pages depending on the device. */
function wheelToPixels(e: WheelEvent, viewportHeight: number): [number, number] {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewportHeight : 1;
  return [e.deltaX * unit, e.deltaY * unit];
}

export class Input {
  /** Set whenever the camera moved this frame, for HUD and URL updates. */
  moved = false;

  private readonly cam: Camera;
  private readonly keys = new Set<string>();
  private dragging = false;
  private pointerId: number | null = null;
  /** Recent pointer samples, used to throw the camera on release. */
  private samples: { t: number; x: number; y: number }[] = [];

  constructor(cam: Camera, target: HTMLElement) {
    this.cam = cam;

    target.addEventListener("wheel", this.onWheel, { passive: false });
    target.addEventListener("pointerdown", this.onPointerDown);
    target.addEventListener("pointermove", this.onPointerMove);
    target.addEventListener("pointerup", this.onPointerUp);
    target.addEventListener("pointercancel", this.onPointerUp);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [dx, dy] = wheelToPixels(e, window.innerHeight);
    // Trackpads already send their own momentum tail, so this is a direct pan
    // rather than an impulse -- adding inertia here would double it up.
    this.cam.panPixels(dx, dy);
    this.cam.vx = 0;
    this.cam.vy = 0;
    this.moved = true;
  };

  private onPointerDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    this.dragging = true;
    this.cam.vx = 0;
    this.cam.vy = 0;
    this.samples = [{ t: performance.now(), x: e.clientX, y: e.clientY }];
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.dragging || e.pointerId !== this.pointerId) return;
    const last = this.samples[this.samples.length - 1];
    if (last) {
      // Dragging right pulls the world right, so the camera goes left.
      this.cam.panPixels(last.x - e.clientX, last.y - e.clientY);
      this.moved = true;
    }
    const now = performance.now();
    this.samples.push({ t: now, x: e.clientX, y: e.clientY });
    while (this.samples.length > 2 && now - this.samples[0]!.t > 90) this.samples.shift();
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.pointerId) return;
    this.dragging = false;
    this.pointerId = null;

    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (first && last) {
      const dt = (last.t - first.t) / 1000;
      if (dt > 0.008) {
        this.cam.vx = (first.x - last.x) / dt / CELL_PX;
        this.cam.vy = (first.y - last.y) / dt / CELL_PX;
      }
    }
    this.samples = [];
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    this.keys.add(e.key.toLowerCase());
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.key.toLowerCase());
  };

  private onBlur = (): void => {
    this.keys.clear();
    this.dragging = false;
    this.pointerId = null;
  };

  /** Advance held-key acceleration and inertia by one frame. */
  update(dt: number): void {
    const k = this.keys;
    let ax = 0;
    let ay = 0;
    if (k.has("arrowleft") || k.has("a")) ax -= 1;
    if (k.has("arrowright") || k.has("d")) ax += 1;
    if (k.has("arrowup") || k.has("w")) ay -= 1;
    if (k.has("arrowdown") || k.has("s")) ay += 1;

    if (ax !== 0 || ay !== 0) {
      const inv = 1 / Math.hypot(ax, ay);
      const boost = k.has("shift") ? 4 : 1;
      this.cam.vx += ax * inv * KEY_ACCEL * boost * dt;
      this.cam.vy += ay * inv * KEY_ACCEL * boost * dt;
      const speed = Math.hypot(this.cam.vx, this.cam.vy);
      const max = KEY_MAX * boost;
      if (speed > max) {
        this.cam.vx *= max / speed;
        this.cam.vy *= max / speed;
      }
    }

    if (this.cam.isMoving()) {
      // Held keys drive the camera directly; drag only takes over on release.
      this.cam.integrate(dt, ax !== 0 || ay !== 0 ? 0.15 : DRAG);
      this.moved = true;
    }
  }
}
