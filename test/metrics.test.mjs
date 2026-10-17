import test from "node:test";
import assert from "node:assert/strict";
import { extractFeatures, medianFeatures, evaluate, ema } from "../docs/metrics.js";

const ASPECT = 16 / 9;

// Build a 33-landmark array (only the ones we use are populated).
function person({ ears = [0.44, 0.3, 0.56, 0.3], shoulders = [0.36, 0.6, 0.64, 0.6], hips = [0.4, 0.85, 0.6, 0.85], nose = null, visibility = 0.9 } = {}) {
  const lms = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, visibility: 0 }));
  const set = (i, x, y, v = visibility) => (lms[i] = { x, y, visibility: v });
  if (nose) set(0, nose[0], nose[1]);
  set(7, ears[0], ears[1]);
  set(8, ears[2], ears[3]);
  set(11, shoulders[0], shoulders[1]);
  set(12, shoulders[2], shoulders[3]);
  set(23, hips[0], hips[1]);
  set(24, hips[2], hips[3]);
  return lms;
}

const upright = () => extractFeatures(person(), ASPECT);

test("extracts sane, scale-invariant features from an upright person", () => {
  const f = upright();
  assert.ok(f, "features should exist");
  assert.ok(f.neck > 0.4 && f.neck < 0.9, `neck ratio looked wrong: ${f.neck}`);
  assert.ok(Math.abs(f.headRoll) < 1, "head should be level");
  assert.ok(Math.abs(f.shoulderRoll) < 1, "shoulders should be level");
  assert.ok(Math.abs(f.lateral) < 0.01, "head should be centred");
  assert.ok(f.torsoLean != null && f.torsoLean < 5, "torso should be vertical");
});

test("features survive being twice as far from the camera", () => {
  // Same pose, all coordinates squeezed toward the centre of the frame.
  const near = upright();
  // Exactly half-size about the frame centre: every coordinate halves toward (0.5, 0.5).
  const far = extractFeatures(
    person({ ears: [0.47, 0.45, 0.53, 0.45], shoulders: [0.43, 0.6, 0.57, 0.6], hips: [0.45, 0.725, 0.55, 0.725] }),
    ASPECT,
  );
  assert.ok(Math.abs(near.neck - far.neck) < 0.02, "neck ratio must not depend on distance");
  assert.ok(Math.abs(near.headScale - far.headScale) < 0.02, "head scale must not depend on distance");
});

test("returns null when the shoulders are not visible", () => {
  const lms = person({ visibility: 0.2 });
  assert.equal(extractFeatures(lms, ASPECT), null);
});

test("baseline barely reacts to camera noise", () => {
  const base = medianFeatures([upright(), upright(), upright()]);
  const jittered = extractFeatures(
    person({ ears: [0.441, 0.302, 0.559, 0.298], shoulders: [0.361, 0.601, 0.639, 0.599] }),
    ASPECT,
  );
  const { score, offenses } = evaluate(jittered, base);
  assert.equal(offenses.length, 0, `noise should not trigger: ${JSON.stringify(offenses)}`);
  assert.equal(score, 100);
});

test("catches slouching / sinking into the chair", () => {
  const base = medianFeatures([upright()]);
  const slouched = extractFeatures(person({ ears: [0.44, 0.46, 0.56, 0.46] }), ASPECT);
  const { score, offenses, primary } = evaluate(slouched, base);
  assert.ok(offenses.some((o) => o.key === "neck"), "neck collapse should be detected");
  assert.equal(primary.key, "neck");
  assert.ok(score < 60, `score should drop, got ${score}`);
});

test("catches a head tilt", () => {
  const base = medianFeatures([upright()]);
  const tilted = extractFeatures(person({ ears: [0.44, 0.32, 0.56, 0.28] }), ASPECT);
  const { offenses } = evaluate(tilted, base);
  assert.ok(offenses.some((o) => o.key === "headRoll"));
});

test("catches leaning on one arm", () => {
  const base = medianFeatures([upright()]);
  // note: x is aspect-corrected, so 0.10 of vertical offset is ~11° of roll
  const leaning = extractFeatures(person({ shoulders: [0.36, 0.55, 0.64, 0.65] }), ASPECT);
  const { offenses } = evaluate(leaning, base);
  assert.ok(offenses.some((o) => o.key === "shoulderRoll"));
});

test("catches slumping sideways", () => {
  const base = medianFeatures([upright()]);
  const sideways = extractFeatures(person({ ears: [0.3, 0.3, 0.42, 0.3] }), ASPECT);
  const { offenses } = evaluate(sideways, base);
  assert.ok(offenses.some((o) => o.key === "lateral"));
});

test("catches leaning into the screen", () => {
  const base = medianFeatures([upright()]);
  const close = extractFeatures(person({ ears: [0.38, 0.3, 0.62, 0.3] }), ASPECT);
  const { offenses } = evaluate(close, base);
  assert.ok(offenses.some((o) => o.key === "leanIn"));
});

test("catches a hunched torso only when hips are visible", () => {
  const base = medianFeatures([upright()]);
  // shoulders level with the hips
  const hunched = extractFeatures(person({ shoulders: [0.36, 0.6, 0.64, 0.6], hips: [0.4, 0.9, 0.6, 0.9] }), ASPECT);
  assert.equal(hunched.torsoLean, 0, "vertical torso should read as 0°");

  const forward = extractFeatures(person({ shoulders: [0.5, 0.5, 0.78, 0.5], hips: [0.4, 0.85, 0.6, 0.85] }), ASPECT);
  assert.ok(forward.torsoLean > 20, `expected a lean, got ${forward.torsoLean}`);
  const { offenses } = evaluate(forward, base);
  assert.ok(offenses.some((o) => o.key === "torsoLean"));
});

test("sensitivity makes it stricter", () => {
  const base = medianFeatures([upright()]);
  // ~12% neck collapse: under the default 14% threshold, over a strict 7% one
  const slight = extractFeatures(person({ ears: [0.44, 0.336, 0.56, 0.336] }), ASPECT);
  const lenient = evaluate(slight, base, { sensitivity: 0.8 });
  const strict = evaluate(slight, base, { sensitivity: 2 });
  assert.equal(lenient.offenses.length, 0, "chill mode should tolerate it");
  assert.ok(strict.offenses.length > 0, "strict mode should flag it");
});

test("measures how far the head is turned", () => {
  const forward = extractFeatures(person({ nose: [0.5, 0.34] }), ASPECT);
  const turned = extractFeatures(person({ nose: [0.62, 0.34] }), ASPECT);
  assert.ok(Math.abs(forward.yaw) < 0.05, `facing the camera should read ~0, got ${forward.yaw}`);
  assert.ok(Math.abs(turned.yaw) > 0.5, `turning away should read high, got ${turned.yaw}`);
});

test("a turned head is not mistaken for leaning in", () => {
  const base = medianFeatures([extractFeatures(person({ nose: [0.5, 0.34] }), ASPECT)]);
  // head is both bigger AND turned hard to one side
  const turned = extractFeatures(
    person({ ears: [0.38, 0.3, 0.62, 0.3], nose: [0.66, 0.3] }),
    ASPECT,
  );
  assert.ok(Math.abs(turned.yaw) > 0.22, "fixture must actually be turned");
  const { offenses } = evaluate(turned, base);
  assert.ok(!offenses.some((o) => o.key === "leanIn"), "yaw must veto the lean-in signal");
});

test("a slight head turn does not veto leaning in", () => {
  const base = medianFeatures([extractFeatures(person({ nose: [0.5, 0.34] }), ASPECT)]);
  // ~0.37 yaw: a bit turned, but the head is also genuinely bigger
  const turned = extractFeatures(person({ ears: [0.38, 0.3, 0.62, 0.3], nose: [0.59, 0.3] }), ASPECT);
  assert.ok(Math.abs(turned.yaw) > 0.2 && Math.abs(turned.yaw) < 0.45, `fixture yaw was ${turned.yaw}`);
  const { offenses } = evaluate(turned, base);
  assert.ok(offenses.some((o) => o.key === "leanIn"), "modest turns must not kill the lean signal");
});

test("catches moving closer even when the head itself is unchanged", () => {
  const base = medianFeatures([upright()]);
  // shoulders now span much more of the frame: the person moved toward the camera
  const closer = extractFeatures(
    person({ ears: [0.43, 0.3, 0.57, 0.3], shoulders: [0.3, 0.6, 0.7, 0.6], hips: [0.4, 0.85, 0.6, 0.85] }),
    ASPECT,
  );
  const { offenses } = evaluate(closer, base);
  assert.ok(offenses.some((o) => o.key === "shoulderSpan"), "shoulder span should catch this");
});

test("hysteresis keeps an active offense from chattering at the threshold", () => {
  const base = medianFeatures([upright()]);
  // ~11% neck collapse: under the 14% entry threshold, over the 8.7% hold threshold
  const mild = extractFeatures(person({ ears: [0.44, 0.333, 0.56, 0.333] }), ASPECT);

  const fresh = evaluate(mild, base);
  assert.ok(!fresh.offenses.some((o) => o.key === "neck"), "should not start an offense under the limit");

  const held = evaluate(mild, base, { previous: ["neck"] });
  assert.ok(held.offenses.some((o) => o.key === "neck"), "should stay active once already flagged");
});

test("the gauge eases down before anything is actually wrong enough to flag", () => {
  const base = medianFeatures([upright()]);
  const drift = extractFeatures(person({ ears: [0.44, 0.327, 0.56, 0.327] }), ASPECT);
  const { score, offenses } = evaluate(drift, base);
  assert.equal(offenses.length, 0, "no offense yet");
  assert.ok(score < 100, `strain should pull the score down, got ${score}`);
  assert.ok(score > 90, `but not dramatically, got ${score}`);
});

test("ema smooths a single bad frame", () => {
  const smoothed = ema(ema(100, 40), 100);
  assert.ok(smoothed > 80, `one bad frame should not tank the score: ${smoothed}`);
});
