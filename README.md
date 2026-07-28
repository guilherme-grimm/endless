# endless

A genuinely infinite 2D procedural field you can pan forever. No content is
reaped, fetched, or stored — every pixel is a pure function of where you are and
which world you are in.

```
bun install
bun dev        # http://localhost:3000
```

`bun run build` emits a static `dist/` (~21 KB, no dependencies).

## Deploying

```
docker build -t endless .
docker run -p 8080:80 endless
```

Bun builds, nginx serves. Nothing runs server-side at all — every pixel is
generated in the browser — so the runtime stage is a static file server rather
than an application server, and the image comes out at 75 MB.

The bundle filename carries a content hash, so it is served `immutable` for a
year while `index.html` is sent `no-cache`; without that split a returning
visitor would never pick up a deploy.

**On Coolify:** choose the *Dockerfile* build pack and set **Ports Exposes** to
`80`. TLS is terminated at Coolify's proxy, so the container speaks plain HTTP.
The `HEALTHCHECK` is already wired up. No environment variables are needed.

## Controls

| | |
|---|---|
| drag · scroll · `wasd` / arrows | move (`shift` to go faster) |
| `g` | jump to a coordinate — any two integers, however long |
| `r` / `n` | new random seed / seed from a word |
| `0` | return to the origin |
| `f` | flat mode — drop the vignette and grain |
| `h` | hide the overlay |

The URL always holds your exact position and seed, so any view can be shared and
will come back identical.

## Why it is actually endless

Two things break every "infinite scroll" past a few million pixels, and both are
addressed structurally rather than papered over.

**The document never scrolls.** Browsers cap document height (Chrome at roughly
33.5M px) and `scrollTop` is a float that gets visibly jittery well before that.
So there is no scrolling element at all: input is intercepted and drives a
virtual camera.

**Position is exact at any magnitude.** The camera is a `BigInt` cell coordinate
plus a fractional offset kept in `[0,1)`. The float half never grows, so
precision at 10^500 is identical to precision at the origin — no drift, no
shimmer, no far-away region where the world falls apart. `src/camera.ts:1`

The hard part is that GLSL has no `BigInt`; it is float32, which dies around
10^7. The shader therefore never sees an absolute coordinate. Instead:

```
camera (BigInt cell + float offset)
   │
   ├─ CPU hashes the lattice points around you, exactly, at every scale
   │  → uploaded as a small float texture array          src/lattice.ts:1
   │
   └─ shader reads gradients from that window using small local indices
      → all arithmetic stays near zero                    src/shaders.ts:1
```

The GPU cannot tell whether you are at the origin or at 10^500. It sees the same
small numbers either way.

Hashing an unbounded integer per lattice point would be slow, so it is made
separable: each axis is folded to 64 bits independently with `BigInt` (once per
row and column), then the pairs are combined with plain 32-bit integer math. For
a 112×112 window that is 224 `BigInt` folds instead of 12,544. `src/hash.ts:1`

**Seams are structurally impossible.** The chunk grid *is* the noise lattice, so
crossing a chunk boundary is just ordinary noise interpolation between two
lattice points that share an exactly-equal hash. There is no stitching step to
get wrong. Verified: moving the camera exactly one cell produces a pixel-exact
translation (max delta 1/255, i.e. 8-bit rounding) — including across 2047→2048,
where all twelve pyramid levels rebuild simultaneously, and at 10^200.

**Nothing reads a clock.** Coordinate + seed determine the pixel completely, on
every machine, forever.

## The field

Twelve octaves spanning 48 px to ~98,000 px, run through two domain warps — one
bending at continental scale, one folding at mid scale — which is what turns
plain noise into flowing strata rather than clouds. Shading comes from
screen-space derivatives of the height field, so it costs nothing extra, and the
contour lines are anti-aliased via `fwidth`.

### Regional character

An infinite world made of one recipe is infinitely the same — only the position
and the hue ever differ. So the coarsest octaves are not drawn at all; they are
read as *parameters*, deciding what kind of place you are in and changing only
over a journey:

| | |
|---|---|
| flavour | each octave folds toward billows or sharp ridges before summing |
| churn | how hard the continental warp bends, laminar through turbulent |
| terracing | whether the ground steps into plateaus or rolls smoothly |
| streak | how far the mid-scale fold is drawn out along a regional axis |
| contours | their spacing, and whether they appear at all |

Measured across the world, that gives roughly 3× spread in edge energy and 8× in
contour density between regions — ridged dune country, carved terraces and
smooth rolling coast are all the same shader.

There is one trap here worth stating plainly. `p` is *camera-relative*, so a
world-consistent effect may only ever be **added** to it. Scaling or rotating
the domain would make the world spin around the viewer as it moved. The
anisotropy is therefore applied by rescaling the warp *displacement* along a
regional axis — a world-consistent vector times a world-consistent scalar — and
never to the domain itself.

Two tuning facts worth knowing before touching the constants:

- **Octave bands must straddle the viewport.** An octave whose cells are far
  larger than the screen cannot show structure — it only shifts the overall
  tone. Bands are chosen so their coarsest member still varies across the view;
  the genuinely huge octaves are used separately, for slow regional drift.
- **`ROUGH` is 0.58, not 1.0.** At 1.0 the coarsest octave of a band swamps the
  rest and the result is a soft blur.
- **Regional parameters are driven to their extremes.** Left proportional they
  hover near their midpoints, and every regime averages into one universal
  texture — the variation is there in the numbers but invisible to the eye.
- **Anything that introduces a hard edge needs a derivative-aware width.** The
  terrace risers scale with `fwidth` and fade out where a pixel spans more than
  a step; the contour width carries a floor, because `fwidth` goes to zero
  across a flat plateau and an unfloored contour becomes a hard threshold that
  breaks into speckle.

Each lattice point carries two independent gradients, so one set of texture
fetches yields two decorrelated noise fields — halving the cost of the warps.

## Performance

Fill-rate bound, as a fullscreen shader should be. The main thread is nearly
idle: it hashes a lattice window only when the camera crosses a boundary, and a
level is rebuilt only when the camera crosses one of *its own* boundaries, so
the fine levels are cheap and the coarse ones almost never touch the bus.

Render resolution is governed automatically — it drops the moment frames are
missed and creeps back up under a ceiling that a failed attempt lowers. Pin it
with `&q=1` in the URL if you would rather choose yourself.

Bun runs the dev server, the bundler and the TypeScript, but note that once the
page loads the server does nothing at all — this is entirely client-side, and
the frame budget is won or lost in the shader.
