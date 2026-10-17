import { PoseLandmarker, FilesetResolver } from "./vendor/vision_bundle.mjs";
import {
  BASE_THRESHOLDS,
  ema,
  evaluate,
  extractFeatures,
  medianFeatures,
  thresholds,
} from "./metrics.js";

const $ = (id) => document.getElementById(id);

const CAL_MS = 3000;
const DEBOUNCE_MS = 1300; // a slouch must persist this long before it counts
const COOLDOWN_MS = 6000; // minimum gap between citations
const SETTINGS_KEY = "posture.settings.v2";

const S = {
  phase: "off", // off | loading | calibrating | monitoring | error
  model: null,
  stream: null,
  raf: 0,

  baseline: null,
  calibSamples: [],
  calibStart: 0,
  calibStartedAt: 0,

  smooth: {},
  score: 100,
  strain: 0,
  offenses: [],
  primary: null,

  badSince: 0,
  lastReactAt: 0,
  lastSeen: 0,
  lastDetect: 0,
  lastTimeline: 0,
  sessionStart: 0,

  stats: { totalMs: 0, goodMs: 0, streakStart: 0, best: 0, citations: 0, fines: 0, counts: {} },
  citations: [],
  timeline: [],

  settings: { voice: true, sound: true, numbers: false, sensitivity: 1 },
  voice: null,
  lineIdx: {},
  present: false,
  lastPaint: 0,
  lastTimelineDraw: 0,
  lastPraiseAt: 0,
  wasBad: false,
};

/* --------------------------------------------------------------- settings */

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    S.settings = { ...S.settings, ...raw };
  } catch {
    /* defaults are fine */
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings));
  } catch {
    /* private mode, no problem */
  }
}

function applySettings() {
  $("sens").value = String(S.settings.sensitivity);
  $("voiceToggle").checked = S.settings.voice;
  $("soundToggle").checked = S.settings.sound;
  $("numbersToggle").checked = S.settings.numbers;
  $("why").hidden = !S.settings.numbers;
  const anyAudio = S.settings.sound || S.settings.voice;
  $("sound").setAttribute("aria-pressed", String(anyAudio));
  $("sound").querySelector(".i-on").hidden = !anyAudio;
  $("sound").querySelector(".i-off").hidden = anyAudio;
  setSensLabel();
}

function setSensLabel() {
  const v = S.settings.sensitivity;
  $("sensLabel").textContent = v < 0.85 ? "chill" : v > 1.45 ? "merciless" : v > 1.15 ? "strict" : "normal";
}

/* ------------------------------------------------------------------ voice */

// Each roast comes with the word that gets stamped across the video.
const ROASTS = {
  neck: [
    { say: "You look like a banana that gave up.", stamp: "BANANA" },
    { say: "You've got the posture of a question mark.", stamp: "CROOKED" },
    { say: "Your neck just left the chat.", stamp: "NECK GONE" },
    { say: "You are shrimp. Full shrimp.", stamp: "SHRIMP" },
    { say: "You look like a cashew with WiFi.", stamp: "CASHEW" },
    { say: "Your head is so far forward it has its own postcode.", stamp: "POSTCODE" },
    { say: "That neck is doing an impression of a slinky.", stamp: "SLINKY" },
    { say: "You've got the silhouette of a comma.", stamp: "COMMA" },
    { say: "You look like a periscope that's had enough.", stamp: "PERISCOPE" },
  ],
  headRoll: [
    { say: "Your head is listing like a cheap sailboat.", stamp: "SAILBOAT" },
    { say: "You're tilted like a picture frame nobody fixed.", stamp: "TILTED" },
    { say: "Your head's at eleven o'clock. It's not noon.", stamp: "11 O'CLOCK" },
    { say: "You look like a dog hearing a weird noise.", stamp: "CONFUSED" },
    { say: "You're holding your head like a phone with no hands.", stamp: "NO HANDS" },
    { say: "Your head's at forty-five degrees. This is not a skateboard trick.", stamp: "45 DEGREES" },
    { say: "You're leaning your brain away from the problem.", stamp: "AVOIDING" },
    { say: "Your head is on a slant and so is my patience.", stamp: "SLANT" },
  ],
  shoulderRoll: [
    { say: "You're leaning like a fence that gave up.", stamp: "FENCE" },
    { say: "One shoulder's on holiday. Call it back.", stamp: "ONE SIDE" },
    { say: "You look like a coat someone threw on a chair.", stamp: "COAT RACK" },
    { say: "Half of you is sitting. The other half is a landslide.", stamp: "LANDSLIDE" },
    { say: "You're propped up like a shed door.", stamp: "SHED DOOR" },
    { say: "One side of you is doing all the work. Again.", stamp: "DOING ALL" },
    { say: "You look like a shrug that got stuck.", stamp: "SHRUG" },
    { say: "That shoulder's off duty. So is your spine.", stamp: "OFF DUTY" },
  ],
  lateral: [
    { say: "You're sliding off that chair like a wet bar of soap.", stamp: "WET SOAP" },
    { say: "You've drifted. Your chair misses you.", stamp: "DRIFTING" },
    { say: "You look like you're leaving a conversation you're still in.", stamp: "LEAVING" },
    { say: "You're sat like a bag of laundry.", stamp: "LAUNDRY" },
    { say: "You're sitting like a car with one bad tyre.", stamp: "BAD TYRE" },
    { say: "You've migrated. The chair is mostly empty.", stamp: "MIGRATED" },
    { say: "You look like a wilting houseplant.", stamp: "HOUSEPLANT" },
    { say: "That's not sitting, that's leaking sideways.", stamp: "LEAKING" },
  ],
  leanIn: [
    { say: "You're close enough to kiss the pixels.", stamp: "TOO CLOSE" },
    { say: "The screen is not a peephole.", stamp: "PEEPHOLE" },
    { say: "You're about to become part of the wallpaper.", stamp: "WALLPAPER" },
    { say: "Back up, you're inhaling the monitor.", stamp: "BACK UP" },
    { say: "You're close enough to read the pixels' names.", stamp: "PIXEL NAMES" },
    { say: "The monitor is not a bowl of soup.", stamp: "NOT SOUP" },
    { say: "You're inspecting the screen like it owes you money.", stamp: "OWES YOU" },
    { say: "Sit back before you merge with the display.", stamp: "MERGING" },
  ],
  torsoLean: [
    { say: "You're folded like a lawn chair.", stamp: "LAWN CHAIR" },
    { say: "You look like a dropped noodle.", stamp: "NOODLE" },
    { say: "Your spine is doing a C. It should do an I.", stamp: "LETTER C" },
    { say: "You're shaped like a parenthesis.", stamp: "BRACKETS" },
    { say: "You're shaped like a prawn.", stamp: "PRAWN" },
    { say: "You look like a folding chair mid-fold.", stamp: "FOLDING" },
    { say: "Your spine is asking for a transfer.", stamp: "TRANSFER" },
    { say: "You're curved like a banana that's seen things.", stamp: "SCARRED" },
  ],
  generic: [
    { say: "Sit up. You look like a comma.", stamp: "COMMA" },
    { say: "Straighten up, you absolute noodle.", stamp: "NOODLE" },
    { say: "You're built like a wet sock.", stamp: "WET SOCK" },
    { say: "Posture. Now. You look like a dropped croissant.", stamp: "CROISSANT" },
    { say: "Sit up. You're a shrimp with a laptop.", stamp: "SHRIMP" },
    { say: "You look like a sad apostrophe.", stamp: "APOSTROPHE" },
    { say: "You're a cautionary tale with a keyboard.", stamp: "CAUTIONARY" },
    { say: "That's not a posture, that's a resignation.", stamp: "RESIGNED" },
    { say: "Straighten up, you damp noodle.", stamp: "DAMP" },
  ],
};

// After three citations it stops being gentle.
const HARSH = {
  neck: [
    { say: "Your head is a hood ornament at this point.", stamp: "HOOD ORNAMENT" },
    { say: "That neck is a chiropractor's retirement fund.", stamp: "INVOICE" },
    { say: "Sit up. That is a cry for help.", stamp: "CRY FOR HELP" },
  ],
  headRoll: [
    { say: "Your head is sagging like a cheap shelf.", stamp: "CHEAP SHELF" },
    { say: "You're crooked in two senses.", stamp: "CROOKED" },
    { say: "You're not a wilting sunflower. Sit up.", stamp: "SUNFLOWER" },
  ],
  shoulderRoll: [
    { say: "That arm is load-bearing now. Move it.", stamp: "LOAD BEARING" },
    { say: "Your shoulder is not a structural support.", stamp: "STRUCTURAL" },
    { say: "One more lean and you're legally a tripod.", stamp: "TRIPOD" },
  ],
  lateral: [
    { say: "The chair has filed a complaint.", stamp: "COMPLAINT" },
    { say: "Sit in the middle. You're not laundry.", stamp: "MIDDLE" },
    { say: "You've drifted so far the camera is guessing.", stamp: "GUESSING" },
  ],
  leanIn: [
    { say: "Back up before you leave fingerprints on the inside.", stamp: "INSIDE JOB" },
    { say: "You're in the screen's personal space.", stamp: "PERSONAL SPACE" },
    { say: "The screen can smell your breath.", stamp: "TOO CLOSE" },
  ],
  torsoLean: [
    { say: "You're folded like laundry. Straighten out.", stamp: "LAUNDRY" },
    { say: "Your spine has a curve that isn't in the manual.", stamp: "MANUAL" },
    { say: "Sit back. You're shaped like a question mark.", stamp: "QUESTION" },
  ],
  generic: [
    { say: "Sit up. This is embarrassing for both of us.", stamp: "EMBARRASSING" },
    { say: "Straighten up before I add a surcharge.", stamp: "SURCHARGE" },
    { say: "Another citation. You're making this expensive.", stamp: "EXPENSIVE" },
  ],
};

const PRAISE = [
  "There he is. Upright.",
  "Look at that. A spine with a person attached.",
  "Better. Your future back says thanks.",
  "Fixed. That was the whole app, honestly.",
  "Okay. Human again.",
];

function pickRoast(key, harsh) {
  const pool = harsh ? HARSH : ROASTS;
  const list = pool[key] || pool.generic;
  const bucket = harsh ? `${key}:harsh` : key;
  const i = ((S.lineIdx[bucket] ?? -1) + 1) % list.length;
  S.lineIdx[bucket] = i;
  return list[i];
}

function loadVoices() {
  const voices = window.speechSynthesis?.getVoices() || [];
  S.voice =
    voices.find((v) => /Samantha|Google US English|Ava|Karen|Daniel/i.test(v.name)) ||
    voices.find((v) => v.lang?.startsWith("en")) ||
    null;
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function speak(text) {
  if (!S.settings.voice || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.06;
  u.pitch = 0.9;
  if (S.voice) u.voice = S.voice;
  speechSynthesis.speak(u);
}

/* ------------------------------------------------------------------ audio */

let actx = null;
function audio() {
  if (!S.settings.sound) return null;
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === "suspended") actx.resume();
    return actx;
  } catch {
    return null;
  }
}

function alertSound() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  for (const [freq, delay, dur] of [
    [320, 0, 0.11],
    [232, 0.14, 0.16],
  ]) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = "square";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.045, t + delay + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(t + delay);
    osc.stop(t + delay + dur + 0.02);
  }
}

function thud() {
  const a = audio();
  if (!a) return;
  const t = a.currentTime;
  const osc = a.createOscillator();
  const gain = a.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(120, t);
  osc.frequency.exponentialRampToValueAtTime(52, t + 0.16);
  gain.gain.setValueAtTime(0.12, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
  osc.connect(gain).connect(a.destination);
  osc.start(t);
  osc.stop(t + 0.22);
}

/* ------------------------------------------------------------------ model */

async function ensureModel() {
  if (S.model) return S.model;
  const fileset = await FilesetResolver.forVisionTasks(new URL("vendor/wasm/", location.href).href);
  const build = (delegate) =>
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL("models/pose_landmarker_lite.task", location.href).href, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      minPoseDetectionConfidence: 0.5,
      minPosePresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

  try {
    S.model = await build("GPU");
  } catch {
    S.model = await build("CPU");
  }
  return S.model;
}

/* ----------------------------------------------------------------- camera */

async function startCamera() {
  if (!["off", "error"].includes(S.phase)) return stopCamera();

  S.phase = "loading";
  setStatus("waking up", "cal");
  setChip("waking up", "cal");
  $("idleTitle").textContent = "Waking up the camera";
  $("idleText").textContent = "Allow camera access, then sit up straight for three seconds.";
  $("start").disabled = true;

  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      audio: false,
    });
    video.srcObject = S.stream;
    await video.play();

    $("modelTag").textContent = "pose model: loading…";
    await ensureModel();
    $("modelTag").textContent = "pose model: pose_landmarker_lite · local";

    $("start").disabled = false;
    $("startText").textContent = "Stop camera";
    $("start").classList.add("on");
    $("idle").classList.add("hidden");
    $("calibrate").disabled = false;
    $("report").disabled = false;

    beginCalibration();
    if (!S.raf) S.raf = requestAnimationFrame(tick);
  } catch (err) {
    $("start").disabled = false;
    S.phase = "error";
    setStatus("blocked", "bad");
    setChip("blocked", "bad");
    $("idleTitle").textContent =
      err?.name === "NotAllowedError" ? "Camera permission denied" : "Couldn't start the camera";
    $("idleText").textContent =
      err?.name === "NotAllowedError"
        ? "Click the camera icon in the address bar, allow access, then hit start again. Nothing is recorded or uploaded."
        : `${err?.message || "Unknown error"}. Check that no other app is using the webcam.`;
  }
}

function stopCamera() {
  cancelAnimationFrame(S.raf);
  S.raf = 0;
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  video.srcObject = null;

  S.phase = "off";
  S.baseline = null;
  S.smooth = {};
  ctx.clearRect(0, 0, overlay.width, overlay.height);

  $("startText").textContent = "Start camera";
  $("start").classList.remove("on");
  $("calibrate").disabled = true;
  $("calib").hidden = true;
  $("idle").classList.remove("hidden");
  $("idleTitle").textContent = "Camera off";
  $("idleText").textContent =
    "It learns what good posture looks like on you, then holds you to it. Everything runs on this laptop — no frames are uploaded or recorded.";
  setStatus("off duty");
  setChip("off duty");
  setScore(null);
  setVerdict("Waiting for you to sit down");
  document.body.classList.remove("alarmed");
  stage.className = "stage";
  hero.classList.remove("bad");
  drawTimeline(performance.now());
}

/* ------------------------------------------------------------- calibration */

function beginCalibration() {
  S.phase = "calibrating";
  S.calibSamples = [];
  S.calibStart = 0;
  S.calibStartedAt = performance.now();
  S.baseline = null;
  S.smooth = {};
  S.badSince = 0;
  S.score = 100;
  S.strain = 0;
  S.offenses = [];
  S.primary = null;
  S.citations = [];
  S.timeline = [];
  S.stats = { totalMs: 0, goodMs: 0, streakStart: 0, best: 0, citations: 0, fines: 0, counts: {} };
  S.lastTimeline = 0;
  S.wasBad = false;
  S.lastPraiseAt = 0;

  $("tickets").innerHTML =
    '<div class="tickets-empty"><span aria-hidden="true">✓</span><p>No citations yet. Keep it that way.</p></div>';
  $("fineTotal").textContent = "$0 owed";
  $("statCount").textContent = "0";

  $("calib").hidden = false;
  $("cdNum").textContent = "3";
  $("cdText").textContent = "Sit up straight. This is your baseline.";
  $("cdHint").textContent = "head and both shoulders in frame";
  $("ring").style.strokeDasharray = "0 100";

  setStatus("calibrating", "cal");
  setChip("calibrating", "cal");
  setVerdict("Learning your good posture…");
  stage.className = "stage cal";
  hero.classList.remove("bad");
}

function finishCalibration() {
  const baseline = medianFeatures(S.calibSamples);
  const samples = S.calibSamples.length;
  S.calibSamples = [];
  $("calib").hidden = true;

  if (!baseline || !Number.isFinite(baseline.neck) || baseline.neck <= 0 || samples < 8) {
    S.phase = "error";
    setStatus("can't see you", "bad");
    setChip("can't see you", "bad");
    stage.className = "stage";
    $("idle").classList.remove("hidden");
    $("idleTitle").textContent = "Couldn't see you";
    $("idleText").textContent =
      "Sit back so your head and both shoulders are in frame, then hit re-calibrate. Good light helps.";
    return;
  }

  S.baseline = baseline;
  S.phase = "monitoring";
  S.sessionStart = performance.now();
  S.lastSeen = S.sessionStart;
  S.stats.streakStart = S.sessionStart;
  S.score = 100;
  S.timeline.push({ t: S.sessionStart, state: 0 });

  stage.className = "stage";
  setStatus("on patrol", "good");
  setChip("on patrol", "good");
  setVerdict("Locked in. Hold it.");
  $("heroState").textContent = "on patrol";
  speak("Baseline locked. Try to keep it.");
}

/* ------------------------------------------------------------------- loop */

function tick(now) {
  S.raf = requestAnimationFrame(tick);
  if (!S.model || !video.videoWidth || video.readyState < 2) return;
  if (now - S.lastDetect < 40) return;
  const dt = Math.min(now - (S.lastDetect || now), 250);
  S.lastDetect = now;

  let result;
  try {
    result = S.model.detectForVideo(video, now);
  } catch {
    return;
  }

  const landmarks = result?.landmarks?.[0];
  const features = landmarks ? extractFeatures(landmarks, video.videoWidth / video.videoHeight) : null;

  if (!features) {
    drawSkeleton(null);
    if (S.phase === "calibrating") {
      if (S.calibStart) {
        // keep counting down if we already found them once
        const left = CAL_MS - (now - S.calibStart);
        $("cdNum").textContent = String(Math.max(1, Math.ceil(left / 1000)));
        if (left <= 0) finishCalibration();
      } else {
        // don't burn the calibration window while the camera is still blind
        $("cdNum").textContent = "—";
        $("cdText").textContent = "Can't see your head and shoulders";
        $("cdHint").textContent = "move back a little, and turn a light on";
        if (now - S.calibStartedAt > 8000) finishCalibration();
      }
    }
    if (S.phase === "monitoring" && now - S.lastSeen > 2000) {
      setStatus("out of frame", "bad");
      setChip("out of frame", "bad");
      setVerdict("Nobody's in frame");
      $("heroState").textContent = "out of frame";
      document.body.classList.remove("alarmed");
      stage.className = "stage";
      hero.classList.remove("bad");
    }
    return;
  }

  S.lastSeen = now;

  if (S.phase === "calibrating") {
    if (!S.calibStart) S.calibStart = now;
    S.calibSamples.push(features);
    const progress = Math.min(1, (now - S.calibStart) / CAL_MS);
    $("ring").style.strokeDasharray = `${(progress * 100).toFixed(1)} 100`;
    $("cdNum").textContent = String(Math.max(1, Math.ceil((1 - progress) * 3)));
    $("cdText").textContent = "Sit up straight. This is your baseline.";
    $("cdHint").textContent = `${S.calibSamples.length} frames captured · hold still`;
    drawSkeleton(landmarks, "cal");
    if (progress >= 1) finishCalibration();
    return;
  }

  if (S.phase !== "monitoring" || !S.baseline) {
    drawSkeleton(landmarks, "cal");
    return;
  }

  for (const key of ["neck", "headRoll", "shoulderRoll", "lateral", "headScale", "shoulderSpan", "torsoLean"]) {
    if (features[key] == null) continue;
    S.smooth[key] = ema(S.smooth[key] ?? features[key], features[key], 0.25);
  }
  const smoothed = { ...S.smooth };
  smoothed.yaw = features.yaw;
  if (features.torsoLean == null) smoothed.torsoLean = null;
  S.features = smoothed;

  const previous = S.offenses.map((o) => o.key);
  const res = evaluate(smoothed, S.baseline, { sensitivity: S.settings.sensitivity, previous });

  S.score = ema(S.score, res.score, 0.22);
  S.strain = ema(S.strain, res.strain, 0.2);
  S.offenses = res.offenses;
  S.primary = res.primary;

  const bad = Boolean(res.primary);
  const shown = Math.round(S.score);

  S.stats.totalMs += dt;
  if (bad) {
    S.stats.streakStart = now;
  } else {
    S.stats.goodMs += dt;
    if (!S.stats.streakStart) S.stats.streakStart = now;
    S.stats.best = Math.max(S.stats.best, now - S.stats.streakStart);
  }

  if (bad) {
    if (!S.badSince) S.badSince = now;
    if (now - S.badSince > DEBOUNCE_MS) {
      react(res.primary, now);
      S.badSince = now;
    }
  } else {
    S.badSince = 0;
    // one quiet compliment when you actually fix it, not a stream of them
    if (S.wasBad && S.stats.citations > 0 && now - S.lastPraiseAt > 90_000) {
      S.lastPraiseAt = now;
      speak(PRAISE[Math.floor(Math.random() * PRAISE.length)]);
    }
  }
  S.wasBad = bad;

  document.body.classList.toggle("alarmed", bad && now - S.badSince > 200);
  stage.className = `stage${bad ? " bad" : ""}`;
  hero.classList.toggle("bad", bad);

  if (now - S.lastTimeline > 1000) {
    S.lastTimeline = now;
    S.timeline.push({ t: now, state: bad ? 1 : 0 });
    if (S.timeline.length > 4000) S.timeline.shift();
  }

  drawSkeleton(landmarks, bad ? "bad" : "good");
  paint({ now, shown, bad, features: smoothed });
}

/* --------------------------------------------------------------- reactions */

function react(offense, now) {
  if (now - S.lastReactAt < COOLDOWN_MS) return;
  S.lastReactAt = now;

  const severity = offense?.severity ?? 0.5;
  const repeats = offense?.key ? (S.stats.counts[offense.key] ?? 0) : 0;
  const harsh = S.stats.citations >= 3;

  // repeat offenders get charged more, because apparently that's the only thing that works
  const base = 5 + Math.round(severity * 3) * 5;
  const multiplier = 1 + repeats * 0.5;
  const fine = Math.min(100, Math.round((base * multiplier) / 5) * 5);

  const citation = {
    n: S.stats.citations + 1,
    at: new Date(),
    label: offense?.label ?? "bad posture",
    detail: offense?.detail ?? "posture went off baseline",
    fine,
    multiplier,
  };

  S.stats.citations = citation.n;
  S.stats.fines += fine;
  if (offense?.key) S.stats.counts[offense.key] = repeats + 1;

  S.citations.unshift(citation);
  if (S.citations.length > 12) S.citations.pop();

  const roast = pickRoast(offense?.key, harsh);

  addTicket(citation);
  flashStamp(roast.stamp);
  alertSound();
  thud();
  speak(roast.say);

  S.timeline.push({ t: now, state: 2 });
  $("fineTotal").textContent = `$${S.stats.fines} owed`;
  $("statCount").textContent = String(S.stats.citations);
}

let stampTimer = 0;
function flashStamp(text = "SIT UP") {
  const stamp = $("stamp");
  stamp.textContent = text;
  stamp.hidden = false;
  stamp.style.animation = "none";
  void stamp.offsetWidth;
  stamp.style.animation = "";
  clearTimeout(stampTimer);
  stampTimer = setTimeout(() => (stamp.hidden = true), 950);
}

function addTicket(c) {
  const list = $("tickets");
  list.querySelector(".tickets-empty")?.remove();

  const el = document.createElement("article");
  el.className = "ticket";
  el.innerHTML = `
    <div class="ticket-id">#<b>${String(c.n).padStart(3, "0")}</b></div>
    <div class="ticket-body">
      <h4>${escapeHtml(cap(c.label))}</h4>
      <p>${escapeHtml(c.detail)} · ${fmtClock(c.at)}</p>
    </div>
    <div class="ticket-fine">$${c.fine}${c.multiplier > 1 ? `<em>×${c.multiplier}</em>` : ""}</div>`;

  list.prepend(el);
  while (list.children.length > 6) list.lastElementChild.remove();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/* ------------------------------------------------------------------- paint */

const hero = $("hero");

function paint({ now, shown, bad, features }) {
  if (now - S.lastPaint < 80) return;
  S.lastPaint = now;

  const color = shown >= 85 ? "var(--good)" : shown >= 60 ? "var(--warn)" : "var(--bad)";
  hero.style.setProperty("--c", color);

  const gaugePct = Math.max(0, Math.min(100, shown));
  hero.style.setProperty("--p", String(gaugePct));
  $("score").textContent = String(shown);

  setVerdict(
    bad && S.primary
      ? `${cap(S.primary.label)}.`
      : shown >= 97
        ? "Textbook. Genuinely."
        : shown >= 90
          ? "Solid. Hold it."
          : "Nearly. Don't drift.",
  );

  $("heroState").textContent = bad ? "slouching" : "on patrol";
  $("heroStrain").textContent = S.strain > 0.02 ? `strain ${Math.round(S.strain * 100)}%` : "";

  const lim = thresholds(S.settings.sensitivity);
  const neckDev = (S.baseline.neck - features.neck) / Math.max(S.baseline.neck, 1e-3);
  const leanDev = (features.headScale - S.baseline.headScale) / Math.max(S.baseline.headScale, 1e-3);
  const tiltDev = Math.max(
    Math.abs(features.headRoll) - Math.abs(S.baseline.headRoll),
    Math.abs(features.shoulderRoll) - Math.abs(S.baseline.shoulderRoll),
  );
  const yawBlocked = Math.abs(features.yaw ?? 0) > 0.22;

  setMeter("meterNeck", neckDev, lim.neck);
  if (yawBlocked) setMeter("meterLean", 0, lim.leanIn, { dim: true, text: "turned" });
  else setMeter("meterLean", leanDev, lim.leanIn);
  setMeter("meterTilt", tiltDev, lim.headRoll);

  const good = S.stats.totalMs > 2500 ? Math.round((S.stats.goodMs / S.stats.totalMs) * 100) : null;
  $("statGood").textContent = good == null ? "--" : `${good}%`;
  $("statStreak").textContent = fmtDur(S.stats.streakStart ? now - S.stats.streakStart : 0);
  $("statBest").textContent = fmtDur(S.stats.best);

  if (S.settings.numbers) paintNumbers(features, lim, yawBlocked);
  if (now - S.lastTimelineDraw > 260) {
    S.lastTimelineDraw = now;
    drawTimeline(now);
  }
}

// Meters read as "percent of your limit": 0% is your baseline, 100% is a citation.
function setMeter(id, dev, limit, opts = {}) {
  const el = $(id);
  const bar = el.querySelector("i");
  const raw = (dev / Math.max(limit, 1e-6)) * 100;
  // landmark jitter shouldn't make the meter twitch while you sit still
  const shown = raw < 12 ? 0 : Math.max(0, Math.min(100, raw));

  bar.style.width = `${shown.toFixed(0)}%`;
  bar.style.background = opts.dim
    ? "var(--faint)"
    : raw >= 100
      ? "var(--bad)"
      : raw >= 60
        ? "var(--warn)"
        : "var(--good)";

  el.querySelector(".m-val").textContent = opts.text ?? `${Math.round(Math.max(0, raw))}%`;
  el.title = opts.text ? "head turned — lean signal paused" : `${Math.round(Math.max(0, raw))}% of the way to a citation`;
}

function setVerdict(text) {
  $("verdict").textContent = text;
}

function setScore(n) {
  $("score").textContent = n == null ? "--" : String(n);
  hero.style.setProperty("--p", n == null ? "0" : String(n));
}

function setStatus(text, tone) {
  $("status").className = `status${tone ? ` ${tone}` : ""}`;
  $("statusText").textContent = text;
}

function setChip(text, tone) {
  $("phaseChip").textContent = text;
  $("phaseChip").className = `chip${tone ? ` ${tone}` : ""}`;
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function fmtClock(d) {
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
}

/* ------------------------------------------------------------- why panel */

const WHY_ROWS = [
  { key: "neck", label: "neck height", kind: "relative", unit: "%" },
  { key: "headScale", label: "head / shoulders", kind: "relative", unit: "%" },
  { key: "headRoll", label: "head roll", kind: "absolute", unit: "°" },
  { key: "shoulderRoll", label: "shoulder roll", kind: "absolute", unit: "°" },
  { key: "lateral", label: "sideways drift", kind: "absolute", unit: "sw" },
  { key: "torsoLean", label: "torso lean", kind: "absolute", unit: "°" },
];

function buildWhy() {
  const grid = $("whyGrid");
  grid.innerHTML = "";
  for (const row of WHY_ROWS) {
    const el = document.createElement("div");
    el.className = "why-row";
    el.innerHTML = `<span class="k">${row.label}</span><div class="why-bar"><i></i></div><span class="v">—</span>`;
    grid.append(el);
    row.el = el;
  }
}

function paintNumbers(features, lim, yawBlocked) {
  if (!S.baseline) return;
  for (const row of WHY_ROWS) {
    const cur = features[row.key];
    const base = S.baseline[row.key];
    const bar = row.el.querySelector("i");
    const val = row.el.querySelector(".v");

    if (cur == null || base == null) {
      val.textContent = "—";
      bar.style.width = "0%";
      continue;
    }

    let dev;
    let text;
    if (row.kind === "relative") {
      dev = row.key === "neck" ? (base - cur) / Math.max(base, 1e-3) : (cur - base) / Math.max(base, 1e-3);
      text = `${dev >= 0 ? "+" : ""}${Math.round(dev * 100)}${row.unit}`;
    } else {
      dev = Math.abs(cur) - Math.abs(base);
      text = `${dev >= 0 ? "+" : ""}${dev.toFixed(row.unit === "sw" ? 2 : 0)}${row.unit}`;
    }

    const thr = (BASE_THRESHOLDS[row.key] ?? 0.1) / S.settings.sensitivity;
    const pct = Math.max(0, Math.min(100, (dev / thr) * 100));
    const blocked = yawBlocked && row.key === "headScale";
    bar.style.width = blocked ? "0%" : `${pct.toFixed(0)}%`;
    bar.style.background = blocked ? "var(--faint)" : pct >= 100 ? "var(--bad)" : pct >= 60 ? "var(--warn)" : "var(--good)";
    val.textContent = blocked ? "turned" : text;
  }
}

/* --------------------------------------------------------------- skeleton */

const CONNECTIONS = [
  [7, 8],
  [7, 11],
  [8, 12],
  [11, 12],
  [11, 23],
  [12, 24],
  [23, 24],
  [11, 13],
  [13, 15],
  [12, 14],
  [14, 16],
];
const JOINTS = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24];
const COLORS = { good: "#e8ece9", bad: "#ff5a5a", cal: "#ffb020" };

function drawSkeleton(landmarks, tone = "cal") {
  const w = overlay.width;
  const h = overlay.height;
  if (!w || !h) return;
  ctx.clearRect(0, 0, w, h);
  if (!landmarks) return;

  const color = COLORS[tone] || COLORS.cal;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = "round";
  ctx.globalAlpha = 0.85;

  const p = (i) => ({ x: landmarks[i].x * w, y: landmarks[i].y * h, v: landmarks[i].visibility ?? 1 });

  ctx.lineWidth = Math.max(2, w / 460);
  for (const [a, b] of CONNECTIONS) {
    const pa = p(a);
    const pb = p(b);
    if (pa.v < 0.4 || pb.v < 0.4) continue;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // the two lines that carry the maths
  ctx.globalAlpha = 0.3;
  ctx.lineWidth = Math.max(5, w / 220);
  const ear7 = p(7);
  const ear8 = p(8);
  const sh11 = p(11);
  const sh12 = p(12);
  ctx.beginPath();
  ctx.moveTo(ear7.x, ear7.y);
  ctx.lineTo(ear8.x, ear8.y);
  ctx.moveTo(sh11.x, sh11.y);
  ctx.lineTo(sh12.x, sh12.y);
  ctx.stroke();

  // joint dots
  ctx.globalAlpha = 1;
  for (const i of JOINTS) {
    const q = p(i);
    if (q.v < 0.4) continue;
    ctx.beginPath();
    ctx.arc(q.x, q.y, Math.max(2.4, w / 320), 0, Math.PI * 2);
    ctx.fill();
  }

  // live neck ratio next to the neck line
  if (ear7.v > 0.4 && sh11.v > 0.4) {
    const mx = (ear7.x + ear8.x + sh11.x + sh12.x) / 4;
    const my = (ear7.y + ear8.y) / 2;
    const value = (Math.hypot(ear7.x - sh11.x, ear7.y - sh11.y) / Math.max(w * 0.18, 1)).toFixed(2);
    ctx.font = `600 ${Math.max(10, Math.round(w / 60))}px ui-monospace, Menlo, monospace`;
    ctx.globalAlpha = 0.75;
    ctx.fillText(value, mx + w * 0.02, my);
  }
}

/* --------------------------------------------------------------- timeline */

function drawTimeline(now) {
  const c = $("timeline");
  const g = c.getContext("2d");
  const w = c.width;
  const h = c.height;
  g.clearRect(0, 0, w, h);

  g.fillStyle = "#0f1213";
  g.fillRect(0, 0, w, h);

  if (!S.sessionStart || !S.timeline.length) return;

  const span = Math.max(60_000, now - S.sessionStart);
  const t0 = now - span;

  for (const seg of S.timeline) {
    if (seg.t < t0) continue;
    const x = ((seg.t - t0) / span) * w;
    const next = ((seg.t + 1000 - t0) / span) * w;
    const width = Math.max(2, next - x - 1);
    g.fillStyle = seg.state === 2 ? "#ff9f43" : seg.state === 1 ? "#ff5a5a" : "#e8ece9";
    g.fillRect(x, 3, Math.min(width, w - x), h - 6);
  }

  $("tlTime").textContent = fmtDur(now - S.sessionStart);
}

/* ----------------------------------------------------------------- report */

function gradeFor(pct) {
  if (pct >= 95) return ["A+", "Flawless. Annoyingly good.", "high"];
  if (pct >= 88) return ["A", "Excellent sitting.", "high"];
  if (pct >= 80) return ["B", "Decent. A few wobbles.", "high"];
  if (pct >= 70) return ["C", "You slipped. A lot.", "mid"];
  if (pct >= 55) return ["D", "Your spine has notes.", "mid"];
  return ["F", "See me after class.", "low"];
}

function reportData() {
  const pct = S.stats.totalMs ? Math.round((100 * S.stats.goodMs) / S.stats.totalMs) : 0;
  const [letter, note, tone] = gradeFor(pct);
  const worstEntry = Object.entries(S.stats.counts).sort((a, b) => b[1] - a[1])[0];
  return {
    pct,
    letter,
    note,
    tone,
    worst: worstEntry ? `${labelFor(worstEntry[0])} ×${worstEntry[1]}` : "none",
    duration: S.stats.totalMs,
    cites: S.stats.citations,
    fines: S.stats.fines,
    best: S.stats.best,
  };
}

function labelFor(key) {
  const map = {
    neck: "sinking",
    headRoll: "head tilt",
    shoulderRoll: "arm lean",
    lateral: "sideways",
    leanIn: "leaning in",
    torsoLean: "hunched",
  };
  return map[key] || key;
}

function openReport() {
  if (!S.sessionStart) return;
  const d = reportData();
  const started = new Date(Date.now() - (performance.now() - S.sessionStart));

  $("gradeLetter").textContent = d.letter;
  $("gradeLetter").className = `grade${d.tone === "mid" ? " mid" : d.tone === "low" ? " low" : ""}`;
  $("gradeNote").textContent = d.note;
  $("reportGood").textContent = `${d.pct}% good posture`;
  $("reportRange").textContent = `${fmtClock(started)} — ${fmtClock(new Date())}`;

  const cells = [
    ["on duty", fmtDur(d.duration)],
    ["good posture", `${d.pct}%`],
    ["best streak", fmtDur(d.best)],
    ["citations", String(d.cites)],
    ["fines owed", `$${d.fines}`],
    ["worst habit", d.worst],
  ];

  $("reportGrid").innerHTML = cells
    .map(([k, v]) => `<div class="report-cell"><b>${escapeHtml(v)}</b><span>${k}</span></div>`)
    .join("");

  $("reportModal").hidden = false;
  $("reportModal").dataset.summary = JSON.stringify(d);
}

function closeReport() {
  $("reportModal").hidden = true;
}

async function saveCard() {
  const d = JSON.parse($("reportModal").dataset.summary || "null");
  if (!d) return;

  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  const g = c.getContext("2d");

  g.fillStyle = "#0b0c0d";
  g.fillRect(0, 0, c.width, c.height);

  // hairline frame
  g.strokeStyle = "#22282a";
  g.lineWidth = 2;
  g.strokeRect(1, 1, c.width - 2, c.height - 2);

  // accent bar
  g.save();
  g.fillStyle = "#ff9f43";
  g.fillRect(0, 0, c.width, 14);
  g.beginPath();
  g.rect(0, 0, c.width, 16);
  g.clip();
  for (let x = -60; x < c.width + 60; x += 46) {
    g.fillStyle = "#0b0c0d";
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x + 23, 0);
    g.lineTo(x + 8, 16);
    g.lineTo(x - 15, 16);
    g.closePath();
    g.fill();
  }
  g.restore();

  g.fillStyle = "#5b6360";
  g.font = "600 20px ui-sans-serif, -apple-system, system-ui, sans-serif";
  g.fillText("POSTURE POLICE · SESSION REPORT", 72, 96);

  g.fillStyle = "#e8ece9";
  g.font = "700 62px ui-sans-serif, -apple-system, system-ui, sans-serif";
  g.fillText(`${d.letter} — ${d.pct}% good posture`, 72, 176);

  const color = d.tone === "high" ? "#ff9f43" : d.tone === "mid" ? "#ffb020" : "#ff4d4d";
  g.beginPath();
  g.arc(972, 300, 108, 0, Math.PI * 2);
  g.strokeStyle = color;
  g.lineWidth = 6;
  g.stroke();
  g.fillStyle = color;
  g.font = "800 96px ui-sans-serif, -apple-system, system-ui, sans-serif";
  g.textAlign = "center";
  g.fillText(d.letter, 972, 336);
  g.textAlign = "start";

  const stats = [
    ["on duty", fmtDur(d.duration)],
    ["best streak", fmtDur(d.best)],
    ["citations", String(d.cites)],
    ["fines owed", `$${d.fines}`],
  ];

  stats.forEach(([k, v], i) => {
    const x = 72 + i * 232;
    g.fillStyle = "#e8ece9";
    g.font = "700 40px ui-sans-serif, -apple-system, system-ui, sans-serif";
    g.fillText(v, x, 400);
    g.fillStyle = "#5b6360";
    g.font = "600 17px ui-sans-serif, -apple-system, system-ui, sans-serif";
    g.fillText(k.toUpperCase(), x, 428);
  });

  g.fillStyle = "#5b6360";
  g.font = "500 19px ui-sans-serif, -apple-system, system-ui, sans-serif";
  g.fillText(`Worst habit: ${d.worst}`, 72, 510);
  g.fillText(new Date().toLocaleString(), 72, 545);

  g.fillStyle = "rgba(255,255,255,0.12)";
  g.fillRect(72, 566, 1056, 1);
  g.fillStyle = "#5b6360";
  g.font = "500 16px ui-sans-serif, -apple-system, system-ui, sans-serif";
  g.fillText("Runs entirely on-device. No video ever left this laptop.", 72, 598);

  const filename = `posture-report-${new Date().toISOString().slice(0, 10)}.png`;
  // keep the share card on the same paper stock as the app
  const btn = $("saveCard");
  const label = btn.textContent;

  // A blob URL in a real <a> works in Safari and Chrome; a bare data: URL does not.
  const download = (href, revoke) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 5000);
  };

  try {
    const blob = await new Promise((resolve) => c.toBlob(resolve, "image/png"));
    if (blob) download(URL.createObjectURL(blob), true);
    else download(c.toDataURL("image/png"), false);
    btn.textContent = "Saved";
  } catch {
    download(c.toDataURL("image/png"), false);
    btn.textContent = "Saved";
  }
  setTimeout(() => (btn.textContent = label), 1800);
}

/* ---------------------------------------------------------------- settings */

function openSettings() {
  $("scrim").hidden = false;
  $("drawer").hidden = false;
}
function closeSettings() {
  $("scrim").hidden = true;
  $("drawer").hidden = true;
}

function resetSession() {
  if (!S.sessionStart) return;
  S.stats = { totalMs: 0, goodMs: 0, streakStart: performance.now(), best: 0, citations: 0, fines: 0, counts: {} };
  S.citations = [];
  S.timeline = [{ t: performance.now(), state: 0 }];
  S.sessionStart = performance.now();
  $("tickets").innerHTML =
    '<div class="tickets-empty"><span aria-hidden="true">✓</span><p>No citations yet. Keep it that way.</p></div>';
  $("fineTotal").textContent = "$0 owed";
  $("statCount").textContent = "0";
  $("statGood").textContent = "--";
  $("statBest").textContent = "0s";
  closeSettings();
}

/* ------------------------------------------------------------------ wiring */

function wire() {
  $("start").addEventListener("click", startCamera);

  $("calibrate").addEventListener("click", () => {
    if (["off", "loading"].includes(S.phase)) return;
    $("idle").classList.add("hidden");
    beginCalibration();
  });

  $("report").addEventListener("click", openReport);
  $("closeReport").addEventListener("click", closeReport);
  $("closeReport2").addEventListener("click", closeReport);
  $("saveCard").addEventListener("click", saveCard);
  $("reportModal").addEventListener("click", (e) => {
    if (e.target === $("reportModal")) closeReport();
  });

  $("present").addEventListener("click", togglePresent);

  // one button mutes everything
  $("sound").addEventListener("click", () => {
    const anyOn = S.settings.sound || S.settings.voice;
    S.settings.sound = !anyOn;
    S.settings.voice = !anyOn;
    $("voiceToggle").checked = S.settings.voice;
    $("soundToggle").checked = S.settings.sound;
    saveSettings();
    applySettings();
    if (!anyOn && "speechSynthesis" in window) speechSynthesis.cancel();
  });

  $("settingsBtn").addEventListener("click", openSettings);
  $("closeSettings").addEventListener("click", closeSettings);
  $("scrim").addEventListener("click", closeSettings);
  $("resetStats").addEventListener("click", resetSession);

  $("sens").addEventListener("input", (e) => {
    S.settings.sensitivity = Number(e.target.value);
    setSensLabel();
    saveSettings();
  });

  $("voiceToggle").addEventListener("change", (e) => {
    S.settings.voice = e.target.checked;
    saveSettings();
  });
  $("soundToggle").addEventListener("change", (e) => {
    S.settings.sound = e.target.checked;
    saveSettings();
    applySettings();
  });
  $("numbersToggle").addEventListener("change", (e) => {
    S.settings.numbers = e.target.checked;
    $("why").hidden = !S.settings.numbers;
    saveSettings();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();

    if (k === "escape") {
      closeReport();
      closeSettings();
      if (S.present) togglePresent();
      return;
    }
    if (k === " " && S.phase === "off") {
      e.preventDefault();
      startCamera();
    }
    if (k === "c" && !$("calibrate").disabled) {
      $("idle").classList.add("hidden");
      beginCalibration();
    }
    if (k === "r") openReport();
    if (k === "s") ($("drawer").hidden ? openSettings : closeSettings)();
    if (k === "m") $("sound").click();
    if (k === "f") togglePresent();
  });
}

function togglePresent() {
  S.present = !S.present;
  document.body.classList.toggle("present", S.present);
  $("present").setAttribute("aria-pressed", String(S.present));
  if (S.present && document.documentElement.requestFullscreen) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else if (!S.present && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
}

/* -------------------------------------------------------------------- boot */

const video = $("video");
const overlay = $("overlay");
const ctx = overlay.getContext("2d");
const stage = $("stage");

loadSettings();
applySettings();
buildWhy();
wire();
drawTimeline(performance.now());

window.__posture = S;

video.addEventListener("loadedmetadata", () => {
  overlay.width = video.videoWidth;
  overlay.height = video.videoHeight;
  drawTimeline(performance.now());
});

setInterval(() => {
  if (video.videoWidth && (overlay.width !== video.videoWidth || overlay.height !== video.videoHeight)) {
    overlay.width = video.videoWidth;
    overlay.height = video.videoHeight;
  }
}, 1000);
