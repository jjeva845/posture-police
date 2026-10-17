// Pure posture geometry. No DOM, no camera — unit-testable.
// Landmarks are { x, y, visibility } in normalized video coords (y grows downward).

export const LM = {
  NOSE: 0,
  L_EAR: 7,
  R_EAR: 8,
  L_SHOULDER: 11,
  R_SHOULDER: 12,
  L_ELBOW: 13,
  R_ELBOW: 14,
  L_WRIST: 15,
  R_WRIST: 16,
  L_HIP: 23,
  R_HIP: 24,
};

// Thresholds for a "normal" person. A higher `sensitivity` divides these,
// so 1.5 = strict (fires sooner), 0.6 = chill.
export const BASE_THRESHOLDS = {
  neck: 0.14, // relative collapse of the neck ratio
  headRoll: 7, // degrees added to head roll
  shoulderRoll: 7, // degrees added to shoulder roll
  lateral: 0.1, // drift of the head off the shoulder midpoint, in shoulder widths
  leanIn: 0.1, // relative growth of head width vs shoulders
  shoulderSpan: 0.12, // relative growth of the shoulder span = you moved closer
  torso: 20, // absolute torso lean, degrees (only when hips are visible)
};

// Beyond this much head turn, "head got bigger" means "you turned your head",
// not "you leaned in". Measured nose offset ÷ ear distance.
// Frontal faces measure ~0.00–0.05, so this only catches a real turn.
const YAW_LIMIT = 0.45;

// An active offense only clears once it drops well under the threshold.
// Loose enough to stop flicker, tight enough not to keep nagging.
const HYSTERESIS = 0.75;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// angle of the line a→b, folded into (-90, 90] so point order never matters
function angleDeg(a, b) {
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return ((((deg + 90) % 180) + 180) % 180) - 90;
}

function point(landmarks, i, aspect) {
  const p = landmarks[i];
  if (!p) return null;
  return { x: p.x * aspect, y: p.y, visibility: p.visibility ?? 1 };
}

/**
 * Turn raw landmarks into scale-invariant features.
 * Returns null when the shoulders or ears aren't confidently visible.
 * `aspect` is videoWidth / videoHeight, so x and y share units.
 */
export function extractFeatures(landmarks, aspect = 16 / 9) {
  if (!landmarks || landmarks.length < 25) return null;

  const lEar = point(landmarks, LM.L_EAR, aspect);
  const rEar = point(landmarks, LM.R_EAR, aspect);
  const lSh = point(landmarks, LM.L_SHOULDER, aspect);
  const rSh = point(landmarks, LM.R_SHOULDER, aspect);

  for (const p of [lEar, rEar, lSh, rSh]) {
    if (!p || p.visibility < 0.5) return null;
  }

  const shoulderWidth = dist(lSh, rSh);
  if (shoulderWidth < 1e-4) return null;

  const earMid = mid(lEar, rEar);
  const shMid = mid(lSh, rSh);
  const earWidth = Math.max(dist(lEar, rEar), 1e-4);

  const nose = point(landmarks, LM.NOSE, aspect);
  const yaw = nose && nose.visibility > 0.4 ? (nose.x - earMid.x) / earWidth : 0;

  const f = {
    // head height above the shoulders, in shoulder widths
    neck: (shMid.y - earMid.y) / shoulderWidth,
    // signed roll of each line, in degrees
    headRoll: angleDeg(lEar, rEar),
    shoulderRoll: angleDeg(lSh, rSh),
    // head sits left/right of the shoulder midpoint
    lateral: (earMid.x - shMid.x) / shoulderWidth,
    // how big the head looks relative to the shoulders (bigger = leaning in)
    headScale: earWidth / shoulderWidth,
    // raw shoulder span: grows when you move toward the camera. Not affected by head turn.
    shoulderSpan: shoulderWidth,
    // 0 when facing the camera, grows as you turn away
    yaw,
    torsoLean: null,
  };

  const lHip = point(landmarks, LM.L_HIP, aspect);
  const rHip = point(landmarks, LM.R_HIP, aspect);
  if (lHip && rHip && lHip.visibility > 0.5 && rHip.visibility > 0.5) {
    const hipMid = mid(lHip, rHip);
    const dx = shMid.x - hipMid.x;
    const dy = shMid.y - hipMid.y;
    if (Math.hypot(dx, dy) > 1e-3) {
      f.torsoLean = Math.abs((Math.atan2(dx, -dy) * 180) / Math.PI);
    }
  }

  return f;
}

export function median(values) {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const FEATURE_KEYS = ["neck", "headRoll", "shoulderRoll", "lateral", "headScale", "shoulderSpan", "torsoLean"];

/** Median of each feature across calibration frames == this person's good posture. */
export function medianFeatures(samples) {
  if (!samples.length) return null;
  const out = { torsoLean: null };
  for (const key of FEATURE_KEYS) {
    const v = median(samples.map((s) => s[key]));
    if (v != null) out[key] = v;
  }
  return out;
}

export function ema(previous, next, alpha = 0.2) {
  return previous == null ? next : previous + alpha * (next - previous);
}

/** How far each signal is allowed to move before it counts, at this sensitivity. */
export function thresholds(sensitivity = 1) {
  const out = {};
  for (const [k, v] of Object.entries(BASE_THRESHOLDS)) out[k] = v / sensitivity;
  return out;
}

/**
 * Compare current features against the calibrated baseline.
 *
 * - `options.previous` is the list of offense keys that were active last frame,
 *   used for hysteresis so an offense doesn't chatter on and off at the threshold.
 * - Returns a 0–100 score, the offenses over the line, and `strain`: a continuous
 *   0–1 measure of how close everything is to the edge (drives the gauge so it
 *   moves before anything actually fires).
 */
export function evaluate(features, baseline, options = {}) {
  const sensitivity = options.sensitivity ?? 1;
  const active = new Set(options.previous || []);
  const t = BASE_THRESHOLDS;
  const limit = thresholds(sensitivity);

  if (!features || !baseline) {
    return { score: 100, offenses: [], primary: null, strain: 0, unavailable: true };
  }

  const offenses = [];
  let strain = 0;

  const add = (key, label, dev, limitFor, span, weight, detail, extraStrainWeight = 1) => {
    // pre-trigger strain: starts at half the limit, so the gauge breathes before a yell
    const preStart = limitFor * 0.5;
    const pre = clamp01((dev - preStart) / (limitFor * 2));
    strain += pre * weight * extraStrainWeight;

    const gate = active.has(key) ? limitFor * HYSTERESIS : limitFor;
    if (dev > gate) {
      offenses.push({
        key,
        label,
        weight,
        detail,
        severity: clamp01((dev - limitFor) / span),
      });
    }
  };

  // 1. the neck disappearing = sinking down in the chair
  const neckDev = (baseline.neck - features.neck) / Math.max(baseline.neck, 1e-3);
  if (neckDev > 0) {
    add("neck", "sinking into the chair", neckDev, limit.neck, 0.25, 1, `${Math.round(neckDev * 100)}% less neck than baseline`);
  }

  // 2. head tipping over
  const headRoll = Math.abs(features.headRoll) - Math.abs(baseline.headRoll);
  if (headRoll > 0) {
    add("headRoll", "head tipping sideways", headRoll, limit.headRoll, 12, 0.85, `${headRoll.toFixed(0)}° past baseline`);
  }

  // 3. leaning on an elbow / one shoulder up
  const shoulderRoll = Math.abs(features.shoulderRoll) - Math.abs(baseline.shoulderRoll);
  if (shoulderRoll > 0) {
    add("shoulderRoll", "leaning on one arm", shoulderRoll, limit.shoulderRoll, 12, 0.9, `${shoulderRoll.toFixed(0)}° shoulder tilt past baseline`);
  }

  // 4. drifting sideways out of your chair
  const lateral = Math.abs(features.lateral - baseline.lateral);
  if (lateral > 0) {
    add("lateral", "slumping sideways", lateral, limit.lateral, 0.2, 0.8, `${lateral.toFixed(2)} shoulder-widths off centre`);
  }

  // 5. face getting bigger = leaning into the screen (unless you just turned your head)
  const leanIn = (features.headScale - baseline.headScale) / Math.max(baseline.headScale, 1e-3);
  const facingCamera = Math.abs(features.yaw ?? 0) <= YAW_LIMIT;
  if (facingCamera && leanIn > 0) {
    add("leanIn", "leaning into the screen", leanIn, limit.leanIn, 0.18, 0.75, `head ${Math.round(leanIn * 100)}% bigger than baseline`);
  }

  // 5b. shoulders filling more of the frame = you physically moved closer.
  // This one survives head turns, which is why it exists.
  if (features.shoulderSpan != null && baseline.shoulderSpan != null) {
    const span = (features.shoulderSpan - baseline.shoulderSpan) / Math.max(baseline.shoulderSpan, 1e-3);
    if (span > 0) {
      add("shoulderSpan", "drifting toward the screen", span, limit.shoulderSpan, 0.2, 0.6, `${Math.round(span * 100)}% closer than baseline`);
    }
  }

  // 6. whole torso hunched forward (needs hips in frame)
  const torsoDev =
    features.torsoLean != null && baseline.torsoLean != null
      ? features.torsoLean - baseline.torsoLean
      : -1;
  if (torsoDev > 0) {
    add("torsoLean", "hunched forward", torsoDev, limit.torso, 15, 1.1, `torso ${features.torsoLean.toFixed(0)}° off vertical`);
  }

  const penalty = offenses.reduce((s, o) => s + o.weight * o.severity, 0);
  strain = clamp01(strain);
  const score = Math.max(0, Math.min(100, Math.round(100 - 68 * clamp01(penalty) - 14 * strain)));

  const primary = offenses.length
    ? offenses.slice().sort((a, b) => b.weight * b.severity - a.weight * a.severity)[0]
    : null;

  return { score, offenses, primary, strain, unavailable: false };
}

export function verdictFor(score) {
  if (score >= 85) return "solid";
  if (score >= 65) return "slipping";
  if (score >= 40) return "bad";
  return "spinal emergency";
}
