const assert = require('assert');
const PitchDetect = require('../pitch-detect.js');

let pass = 0, fail = 0;
function near(desc, got, expected, tolerance) {
  try {
    assert.ok(
      got != null && Math.abs(got - expected) <= tolerance,
      `${got} not within ${tolerance} of ${expected}`
    );
    pass++;
  } catch (e) {
    fail++;
    console.error(`FAIL: ${desc} => ${e.message}`);
  }
}
function eq(desc, got, expected) {
  try { assert.strictEqual(got, expected); pass++; }
  catch (e) { fail++; console.error(`FAIL: ${desc} => ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`); }
}

// Synthesize a pure sine wave at `freqHz` sampled at `sampleRate`, `n`
// samples long, at unit amplitude.
function sineWave(freqHz, sampleRate, n) {
  const buf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    buf[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return buf;
}

// Synthesize a harmonic-rich, noisy signal standing in for real voiced
// speech -- a pure sine is the easiest possible input for an
// autocorrelation pitch estimator and doesn't exercise its main failure
// mode (octave errors: real voiced frames have strong energy at 2x/3x the
// true F0 too, since a harmonic stack's partials all correlate at
// sub-multiples of the fundamental's period). This is the shape that
// actually stresses the estimator the way real speech would.
function voicedLike(f0, sampleRate, n) {
  const buf = new Float32Array(n);
  let seed = 7;
  function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  }
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    buf[i] =
      Math.sin(2 * Math.PI * f0 * t) +
      0.6 * Math.sin(2 * Math.PI * 2 * f0 * t) +
      0.4 * Math.sin(2 * Math.PI * 3 * f0 * t) +
      0.2 * Math.sin(2 * Math.PI * 4 * f0 * t) +
      0.02 * rnd();
  }
  return buf;
}

const SAMPLE_RATE = 48000;
const N = PitchDetect._FRAME_SIZE;

// -- Known frequencies, pure sine (baseline sanity check) ---------------

{
  const hz = PitchDetect._estimatePitch(sineWave(110, SAMPLE_RATE, N), SAMPLE_RATE);
  near('110Hz pure sine detected within 2Hz', hz, 110, 2);
}

{
  const hz = PitchDetect._estimatePitch(sineWave(220, SAMPLE_RATE, N), SAMPLE_RATE);
  near('220Hz pure sine detected within 3Hz', hz, 220, 3);
}

// -- Known frequencies, harmonic-rich + noise (the real stress test) ----
// 150Hz and 220Hz are chosen because their sub-octaves (75Hz, 110Hz) both
// fall inside MIN_HZ..MAX_HZ (70-400) -- an octave-down error is reachable
// for these, unlike a fundamental whose sub-octave would be rejected by
// the frequency-range bound for free.

{
  const hz = PitchDetect._estimatePitch(voicedLike(150, SAMPLE_RATE, N), SAMPLE_RATE);
  near('150Hz harmonic-rich voiced-like signal detected at the fundamental, not an octave down', hz, 150, 3);
}

{
  const hz = PitchDetect._estimatePitch(voicedLike(220, SAMPLE_RATE, N), SAMPLE_RATE);
  near('220Hz harmonic-rich voiced-like signal detected at the fundamental, not an octave down', hz, 220, 3);
}

{
  const hz = PitchDetect._estimatePitch(voicedLike(100, SAMPLE_RATE, N), SAMPLE_RATE);
  near('100Hz harmonic-rich voiced-like signal detected at the fundamental, not an octave down', hz, 100, 3);
}

// -- Silence yields no pitch, not a false reading -----------------------

{
  const silence = new Float32Array(N); // all zeros
  const hz = PitchDetect._estimatePitch(silence, SAMPLE_RATE);
  eq('silent frame yields null (unvoiced)', hz, null);
}

// -- White noise (no periodicity) should not produce a confident pitch --

{
  // Deterministic pseudo-random noise (not Math.random, for reproducible
  // test runs) -- a simple LCG.
  let seed = 42;
  function rnd() {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 2 - 1;
  }
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = rnd();
  const hz = PitchDetect._estimatePitch(noise, SAMPLE_RATE);
  eq('uncorrelated noise yields null (below voicing threshold)', hz, null);
}

// -- unsupportedReason() distinguishes insecure-context from true
// unsupported, since the two need different user-facing advice (see
// js/app.js's UNSUPPORTED_MESSAGES, which depends on this exact function
// existing and being exported -- do not delete this without also updating
// app.js's boot()) --------------------------------------------------------
//
// These mutate global.window/global.navigator to drive the module's dynamic
// `typeof window`/`typeof navigator` checks (root.AudioContext isn't
// reachable this way -- it's a private reference captured once at require()
// time inside the module's UMD closure -- so 'no-audio-context' isn't
// separately exercised here; the case below where navigator.mediaDevices IS
// present still naturally returns 'no-audio-context', not null, because
// this Node environment's captured root has no AudioContext either way,
// which incidentally covers that branch too).
function withGlobals(overrides, fn) {
  const originals = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = Object.getOwnPropertyDescriptor(global, key);
    Object.defineProperty(global, key, { value: overrides[key], configurable: true, writable: true });
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (originals[key]) Object.defineProperty(global, key, originals[key]);
      else delete global[key];
    }
  }
}

withGlobals({ window: { isSecureContext: false }, navigator: undefined }, () => {
  eq('insecure context reported even though window exists', PitchDetect.unsupportedReason(), 'insecure-context');
});

withGlobals({ window: { isSecureContext: true }, navigator: undefined }, () => {
  eq('secure context but no navigator.mediaDevices -> no-media-devices', PitchDetect.unsupportedReason(), 'no-media-devices');
});

withGlobals(
  { window: { isSecureContext: true }, navigator: { mediaDevices: { getUserMedia: function () {} } } },
  () => {
    // See the comment above withGlobals -- this Node environment's captured
    // `root` has no AudioContext, so this lands on 'no-audio-context' rather
    // than null even though mediaDevices is present, which is expected here.
    eq(
      'secure context + mediaDevices present, but no AudioContext -> no-audio-context',
      PitchDetect.unsupportedReason(),
      'no-audio-context'
    );
  }
);

console.log(`pitch-detect-test: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
