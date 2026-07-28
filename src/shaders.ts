import { HALF, LEVELS, TEX } from "./lattice.ts";

export const VERTEX_SRC = `#version 300 es
// One fullscreen triangle; no vertex buffer, positions come from gl_VertexID.
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

export const FRAGMENT_SRC = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;

#define LEVELS ${LEVELS}
#define HALF ${HALF}
#define TEX ${TEX}

uniform sampler2DArray uLat;
uniform vec2  uModBase[LEVELS];
uniform vec2  uCamOff;
uniform vec2  uRes;
uniform float uCellPx;
uniform float uBands;
uniform float uPost;   // 0 disables the screen-space vignette and grain
uniform vec3  uPalA, uPalB, uPalC, uPalD;

out vec4 fragColor;

// Lattice lookup in local indices. The shader never sees a world coordinate --
// that is the whole reason this stays exact at 10^500.
vec4 latAt(ivec2 c, int k) {
  ivec2 t = clamp(c + ivec2(HALF), ivec2(0), ivec2(TEX - 1));
  return texelFetch(uLat, ivec3(t, k), 0);
}

// Gradient noise, evaluated twice at once: each lattice point carries two
// independent unit gradients (xy and zw), so one set of texture fetches yields
// two decorrelated fields. That halves the cost of the domain warps.
vec2 gnoise2(vec2 q, int k) {
  vec2 f = floor(q);
  vec2 t = q - f;
  ivec2 c = ivec2(f);
  vec2 u = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);

  vec4 g00 = latAt(c, k);
  vec4 g10 = latAt(c + ivec2(1, 0), k);
  vec4 g01 = latAt(c + ivec2(0, 1), k);
  vec4 g11 = latAt(c + ivec2(1, 1), k);

  vec2 d00 = t;
  vec2 d10 = t - vec2(1.0, 0.0);
  vec2 d01 = t - vec2(0.0, 1.0);
  vec2 d11 = t - vec2(1.0, 1.0);

  vec2 a = vec2(dot(g00.xy, d00), dot(g00.zw, d00));
  vec2 b = vec2(dot(g10.xy, d10), dot(g10.zw, d10));
  vec2 c0 = vec2(dot(g01.xy, d01), dot(g01.zw, d01));
  vec2 d0 = vec2(dot(g11.xy, d11), dot(g11.zw, d11));

  return mix(mix(a, b, u.x), mix(c0, d0, u.x), u.y);
}

// Roughness. Amplitude goes as 2^(k*ROUGH): at 1.0 the coarsest octave of a
// band swamps the rest and the result is a soft blur, so this is pulled well
// below that to let the fine octaves carve visible texture.
#define ROUGH 0.58

// Mean of abs(gradient noise), used to re-centre the folded variants so that
// changing flavour shifts the character of the field without also shifting its
// overall brightness.
#define ABS_MEAN 0.36

// Fractal sum over a band of octaves, normalised within that band. The band has
// to be chosen so its coarsest octave still varies across the viewport --
// octaves far larger than the screen only shift the overall tone.
//
// The flavour argument folds each octave before summing: 0 leaves plain noise,
// +1 reflects it into sharp ridges (creases, mountain crests), -1 into billows
// (soft mounds). Folding per octave rather than after the sum is what puts
// creases at every scale instead of only the coarsest.
vec2 fbm2(vec2 p, int k0, int k1, float flavour) {
  vec2 sum = vec2(0.0);
  float norm = 0.0;
  float dir = sign(flavour);
  float amt = abs(flavour);
  for (int k = 0; k < LEVELS; k++) {
    if (k < k0) continue;
    if (k > k1) break;
    float s = exp2(float(k));
    float amp = exp2(float(k) * ROUGH);
    vec2 q = uModBase[k] + (uCamOff + p) / s;
    vec2 n = gnoise2(q, k);
    vec2 folded = (2.0 * abs(n) - ABS_MEAN) * -dir;
    sum += mix(n, folded, amt) * amp;
    norm += amp;
  }
  return sum / norm;
}

vec3 palette(float t) {
  return uPalA + uPalB * cos(6.28318530718 * (uPalC * t + uPalD));
}

void main() {
  // Position relative to the camera, in cells. World +y points down the screen.
  vec2 p = vec2(gl_FragCoord.x - 0.5 * uRes.x, 0.5 * uRes.y - gl_FragCoord.y) / uCellPx;

  // Regional character. These bands are far coarser than the screen, so they
  // barely vary within one view -- instead they decide what *kind* of place
  // this is, and change over a journey. Without them an infinite world is
  // infinitely the same: only the position and the hue would ever differ.
  vec2 regA = fbm2(p, 6, 9, 0.0);
  vec2 regB = fbm2(p, 8, LEVELS - 1, 0.0);

  // Push these to their extremes rather than letting them hover near the
  // middle. The point is to land somewhere with a definite character, not to
  // average every regime together into one universal texture.
  float flavour = clamp(regA.x * 8.0, -1.0, 1.0);              // billows <-> ridges
  float churn = 0.20 + 2.40 * smoothstep(-0.14, 0.14, regA.y); // laminar <-> turbulent
  float terrace = 0.80 * smoothstep(0.10, -0.10, regA.y);      // calm country steps
  float streak = smoothstep(0.07, -0.13, regB.y);              // isotropic <-> fibrous
  float ang = regB.y * 6.2831853;

  // A pair of domain warps: the first bends the field at continental scale, the
  // second folds that result at mid scale. This is what turns plain noise into
  // flowing strata rather than clouds. Nothing here reads a clock: a coordinate
  // and a seed determine the pixel completely, on every machine, forever.
  vec2 w1 = fbm2(p, 4, 8, 0.0) * 40.0 * churn;
  w1 = clamp(w1, vec2(-60.0), vec2(60.0));

  vec2 w2 = fbm2(p + w1, 2, 6, 0.0) * 18.0;

  // Stretch the mid-scale fold along a regional axis, so some places stay
  // blobby and others are drawn out into fibres and bands. Note this rescales
  // the *displacement*, never the domain: p is relative to the camera, so
  // rotating or scaling p would spin the world around the viewer as it moved.
  // A world-consistent vector scaled by a world-consistent scalar stays world
  // consistent, which is why this is safe and a domain transform would not be.
  vec2 axis = vec2(cos(ang), sin(ang));
  vec2 perp = vec2(-axis.y, axis.x);
  w2 = axis * dot(w2, axis) * (1.0 + 2.0 * streak)
     + perp * dot(w2, perp) * (1.0 - 0.75 * streak);
  // Insurance: a warped sample must never reach outside the lattice window.
  w2 = clamp(w2, vec2(-22.0), vec2(22.0));

  vec2 fld = fbm2(p + w2, 0, 6, flavour);

  float h = fld.x;
  float m = fld.y;

  // Terracing: some country steps into plateaus instead of rolling smoothly.
  // A completely different silhouette for a handful of instructions, and the
  // shading below picks up the risers on its own.
  float steps = 6.0 + 14.0 * smoothstep(-0.25, 0.25, regB.x);
  float ladder = h * steps;
  // The risers have to be anti-aliased or they turn to speckle wherever the
  // field is steep. Their width tracks the screen-space gradient, and the whole
  // effect fades out where a single pixel spans more than a step -- detail that
  // cannot be resolved is better dropped than aliased.
  float lw = fwidth(ladder);
  float riser = clamp(lw * 2.0, 0.06, 0.45);
  float soft = smoothstep(0.5 - riser, 0.5 + riser, fract(ladder));
  float stepped = (floor(ladder) + soft) / steps;
  h = mix(h, stepped, terrace * (1.0 - smoothstep(0.45, 1.10, lw)));

  // Screen-space derivatives give shading for free, and scaling by uCellPx
  // keeps the result identical at any render resolution.
  vec2 grad = vec2(dFdx(h), dFdy(h)) * uCellPx;
  vec3 nrm = normalize(vec3(-grad * 2.4, 1.0));
  float lambert = clamp(dot(nrm, normalize(vec3(-0.55, -0.7, 0.62))), 0.0, 1.0);
  float rim = pow(1.0 - abs(nrm.z), 3.0);

  // Keep the palette index inside roughly one cycle per screen; sweeping
  // through several turns the field into a rainbow smear.
  float t = h * 0.85 + 0.5 + m * 0.14 + regB.x * 0.30 + flavour * 0.10;
  vec3 col = palette(t);

  // Anti-aliased contour lines through the height field: the strata read as
  // topography instead of a gradient smear. Both the spacing and whether they
  // appear at all are regional, so contoured country gives way to bare country.
  float density = uBands * mix(0.45, 2.4, smoothstep(-0.28, 0.28, regB.x));
  float presence = smoothstep(-0.40, -0.05, regA.x);
  float bandCoord = h * density;
  // The floor matters on terraced ground: fwidth goes to zero across a flat
  // plateau, and without it the contour degenerates into a hard threshold that
  // breaks up into speckle wherever the plateau sits near a band edge.
  float bw = fwidth(bandCoord) * 1.6 + 0.015;
  float band = fract(bandCoord);
  float line = smoothstep(0.0, bw, band) * smoothstep(0.0, bw, 1.0 - band);
  col *= mix(1.0, mix(0.62, 1.0, line), presence);

  col *= 0.55 + 0.75 * lambert;
  col += rim * 0.12 * palette(t + 0.35);

  // A tight highlight, so ridged country catches the light along its crests
  // and billowed country stays matte.
  vec3 halfway = normalize(normalize(vec3(-0.55, -0.7, 0.62)) + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(nrm, halfway), 0.0), 34.0);
  col += spec * (0.05 + 0.30 * max(0.0, flavour));

  // Gentle S-curve for contrast, then a light vignette.
  col = clamp(col, 0.0, 1.0);
  col = col * col * (3.0 - 2.0 * col) * 0.35 + col * 0.65;

  vec2 uv = gl_FragCoord.xy / uRes;
  col *= 1.0 - 0.32 * uPost * dot(uv - 0.5, uv - 0.5);

  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col += (grain - 0.5) * 0.012 * uPost;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;
