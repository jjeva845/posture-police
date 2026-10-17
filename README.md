# Posture Police

Your webcam watches your posture, calls you a banana, and hands you a citation. Charcoal instrument-panel interface, local pose model, no frames uploaded, recorded, or sent anywhere.

▶ **Try it live: [https://jjeva845.github.io/posture-police/](https://jjeva845.github.io/posture-police/)** — allow the camera, calibrate, and try to slouch. Works in Chrome or Safari, nothing to install.

```bash
cd posture
node server.mjs        # → http://localhost:4322
```

Needs Chrome or Safari, a webcam, and nothing else. The pose model and WASM runtime are vendored in `public/`, so it works offline.

## Using it

1. **Start camera** — allow access.
2. **Sit up straight for 3 seconds.** That becomes your personal baseline.
3. Slouch. After ~1.6s it turns red, yells, and writes you a citation with a fine.
4. `Re-calibrate` after changing chair, camera height, or desk.
5. `Report` (or `R`) gives you a graded session summary you can save as a share card.

| Key | Does |
| --- | --- |
| `space` | start / stop camera |
| `c` | re-calibrate |
| `r` | session report |
| `s` | settings |
| `m` | mute everything |
| `f` | presentation mode (big type, fullscreen) |

## The roasts

Every offence has its own set of insults, and each one slams a matching one-word stamp across the video:

| offence | example | stamp |
| --- | --- | --- |
| sinking | "You look like a banana that gave up." | BANANA |
| leaning in | "The screen is not a peephole." | PEEPHOLE |
| hunched | "You're folded like a lawn chair." | LAWN CHAIR |
| sideways | "You're sliding off that chair like a wet bar of soap." | WET SOAP |
| head tilt | "You look like a dog hearing a weird noise." | CONFUSED |

They cycle rather than repeat, so a long session doesn't get one joke on loop. Fix your posture after a citation and it occasionally admits it: *"Look at that. A spine with a person attached."*

There are two tiers. After three citations it stops being gentle and switches to a meaner set (*"Your head is a hood ornament at this point."*). Repeat offences also cost more: the base fine gets multiplied by 1.5× for every repeat of the same offence, so a habit gets expensive fast — 10, 15, 20, 25.

## What's on screen

- **Spine score** — 0–100, driven by how far you are from your own baseline. It starts easing down before an offense actually fires, so the gauge moves like a gauge rather than a step function.
- **Three meters** — neck, lean and tilt, shown as *percent of your limit*. 0% is your baseline, 100% is a citation.
- **Citations** — every yell becomes a ticket: offence, timestamp, fine. The total is your session's bill.
- **Session timeline** — white where you sat well, red where you slouched, amber where it caught you.
- **Settings** — strictness, voice, alert sounds, and a panel with all six raw ratios against your baseline.

## How it decides

MediaPipe's `pose_landmarker_lite` gives 33 body points per frame. Nothing is trained here — the work is geometry. Six scale-invariant features are computed from the landmarks, then compared to the median of your calibration frames:

| feature | how it's measured | slouch looks like |
| --- | --- | --- |
| `neck` | ear midpoint → shoulder midpoint ÷ shoulder width | shrinking (you sink) |
| `headScale` | ear-to-ear ÷ shoulder width | growing (you lean in) |
| `shoulderSpan` | shoulder width in frame | growing (you physically moved closer) |
| `headRoll` | angle of the ear line, degrees | tilting from your baseline |
| `shoulderRoll` | angle of the shoulder line, degrees | one shoulder dropping |
| `lateral` | head offset from shoulder midpoint ÷ shoulder width | drifting sideways |
| `torsoLean` | shoulder→hip angle vs vertical (needs hips in frame) | hunched forward |

Dividing by shoulder width is what makes it work at any distance from the camera — a proper 2× zoom-out leaves every ratio unchanged (there's a test for that).

Three things keep it from being annoying:

- **Yaw gate** — if you turn your head more than ~22°, "the head got bigger" means "you turned", not "you leaned in", so that signal is ignored (and the meter says `turned`).
- **Hysteresis** — an offence clears at 62% of the threshold that started it, so it can't chatter on and off at the line.
- **Persistence** — a bad state has to survive 1.6s before it costs you a citation; yells are at least 6s apart.

Smoothing is exponential (α = 0.25 per frame at ~25fps).

## Tests

```bash
node --test test/
```

18 tests cover feature extraction, distance invariance, each offence type, yaw rejection (and the fact that a *slight* turn must not veto a real lean), shoulder-span lean detection, hysteresis, pre-trigger strain, noise rejection, sensitivity, and smoothing. The browser pipeline (model → landmarks → baseline → score → citation → report → share card) was verified separately against a real face fed in as a fake webcam.

## Limits worth knowing

- One 2D camera, so torso lean only works when your hips are in frame.
- `headScale` is the least reliable signal; it's weighted lowest and gated by yaw, but a lot of head turning will keep it quiet rather than wrong.
- Bad backlight or a busy background drops landmark confidence, which reads as "can't see you" rather than a false yell.
- Calibration is per-session on purpose — it's tied to where the camera is.
- Fines are imaginary. The shame is real.
