// pitch-detect.js -- microphone capture + per-frame F0 (pitch) estimation.
//
// Exposes a single global `PitchDetect` (IIFE-scoped), matching the style of
// sibling apps' plain-<script> globals. No external library, no CDN script.
//
// Pipeline: getUserMedia -> AudioContext -> AnalyserNode, polled via
// setInterval (see "Open items" in the design spec: AnalyserNode polling
// chosen over AudioWorklet here for simplicity -- no separate worklet module
// to load or postMessage plumbing to wire up. setInterval rather than
// requestAnimationFrame specifically because rAF pauses in a backgrounded
// tab, which would silently truncate a recording if the learner switches
// away mid-take; setInterval keeps firing regardless of tab visibility).
// Each poll reads the current time-domain buffer and runs
// autocorrelation-based F0 estimation on it.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.PitchDetect = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  // Frame size: 1024 samples. At a typical 48kHz mic sample rate that's
  // ~21.3ms of audio per frame -- short enough to track pitch changes within
  // a single mora (moras are typically 100-200ms), long enough to contain at
  // least 2-3 periods of the lowest voice-relevant frequency we care about
  // (~75Hz for a low male voice: one period is ~13.3ms, so 1024 samples at
  // 48kHz comfortably spans several periods, which normalized autocorrelation
  // needs to find a reliable lag peak). This is the latency-vs-frequency-
  // resolution trade-off: smaller frames track fast pitch movement better
  // but make low-frequency periods unreliable to detect; 1024 is a standard
  // middle ground for speech F0 tracking.
  var FRAME_SIZE = 1024;

  // Hop size: how often (in ms) we poll the analyser and record a frame.
  // 20ms hop gives ~50 pitch samples/sec, dense enough for smooth per-mora
  // medians without polling faster than the rAF loop can realistically
  // sustain.
  var HOP_MS = 20;

  // Plausible human voice F0 range in Hz -- autocorrelation lag search is
  // bounded to this range both to reject octave errors and to skip
  // unproductive lag values.
  var MIN_HZ = 70;
  var MAX_HZ = 400;

  // Below this normalized autocorrelation confidence, a frame is treated as
  // unvoiced (hz: null) rather than trusting a noisy pitch estimate.
  var VOICING_THRESHOLD = 0.35;

  // Recording auto-stops after this many ms if the caller doesn't stop it
  // first, per the spec's "max duration auto-stop, e.g. 3s" suggestion.
  var MAX_DURATION_MS = 3000;

  var state = null; // set while a recording is in progress; null otherwise

  // Distinguishes *why* recording is unavailable, since the two causes need
  // very different user-facing advice: a genuinely old/incapable browser
  // should be told to upgrade, but a modern browser serving the page over an
  // insecure origin (plain http on anything other than localhost/127.0.0.1)
  // hides navigator.mediaDevices entirely as a security measure -- that user
  // needs to fix the URL (use localhost, or HTTPS), not switch browsers.
  // Returns one of 'insecure-context' | 'no-media-devices' | 'no-audio-context'
  // | null (null means recording is supported). js/app.js's boot() depends on
  // this exact function existing and being exported -- do not remove it
  // without also updating app.js's UNSUPPORTED_MESSAGES/boot() call site.
  function unsupportedReason() {
    var w = (typeof window !== 'undefined') ? window : root;
    if (w && w.isSecureContext === false) return 'insecure-context';
    var nav = (typeof navigator !== 'undefined') ? navigator : (root && root.navigator);
    if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      return 'no-media-devices';
    }
    if (!(root && (root.AudioContext || root.webkitAudioContext))) return 'no-audio-context';
    return null;
  }

  function isSupported() {
    return unsupportedReason() === null;
  }

  // Normalized autocorrelation F0 estimate for one frame of time-domain
  // samples (Float32Array, values in [-1, 1]). Returns a frequency in Hz, or
  // null if the frame doesn't look voiced.
  function estimatePitch(samples, sampleRate) {
    var n = samples.length;

    // Remove DC offset -- an unremoved DC bias inflates autocorrelation at
    // all lags and can mask the true periodicity peak.
    var mean = 0;
    for (var i = 0; i < n; i++) mean += samples[i];
    mean /= n;

    var buf = new Float32Array(n);
    var energy = 0;
    for (i = 0; i < n; i++) {
      var v = samples[i] - mean;
      buf[i] = v;
      energy += v * v;
    }

    // Near-silent frame -- not enough signal energy to trust any lag peak.
    if (energy < 1e-6) return null;

    var minLag = Math.floor(sampleRate / MAX_HZ);
    var maxLag = Math.ceil(sampleRate / MIN_HZ);
    maxLag = Math.min(maxLag, n - 1);
    if (minLag < 1) minLag = 1;
    if (maxLag <= minLag) return null;

    var bestLag = -1;
    var bestCorr = 0;
    // Correlation at every lag we scan, so we can look for a smaller lag
    // (higher frequency) whose peak is nearly as strong as the global max --
    // see the octave-error guard below.
    var corrAtLag = new Float32Array(maxLag + 1);

    for (var lag = minLag; lag <= maxLag; lag++) {
      var corr = 0;
      var normA = 0;
      var normB = 0;
      var limit = n - lag;
      for (var j = 0; j < limit; j++) {
        var a = buf[j];
        var b = buf[j + lag];
        corr += a * b;
        normA += a * a;
        normB += b * b;
      }
      var denom = Math.sqrt(normA * normB);
      var normalized = denom > 0 ? corr / denom : 0;
      corrAtLag[lag] = normalized;
      if (normalized > bestCorr) {
        bestCorr = normalized;
        bestLag = lag;
      }
    }

    if (bestLag < 0 || bestCorr < VOICING_THRESHOLD) return null;

    // Octave-error guard: a harmonic-rich voiced frame can score a hair
    // higher at 2x/3x the true period than at the true period itself,
    // which would make the raw global argmax report half (or a third) of
    // the real F0. Check whether an exact submultiple of the detected lag
    // (bestLag/2, bestLag/3, ...) is *also* strongly correlated -- if so,
    // that submultiple is the true (shorter) period and bestLag is a
    // multiple of it, so prefer the shorter lag. This only considers exact
    // integer divisions of bestLag, not every lag in range, so it can't be
    // fooled by an unrelated lag that happens to correlate well by chance.
    var acceptThreshold = bestCorr * 0.9;
    // Every candidate is a submultiple of the ORIGINAL detected peak
    // (rawBestLag), not of `bestLag` as it gets reassigned below -- dividing
    // the running (already-corrected) value here would test the wrong lags
    // for k=3..6 once an earlier k has already matched (e.g. bestLag/2 then
    // (bestLag/2)/3 instead of bestLag/3), which can under- or over-correct
    // the pitch by an extra octave.
    var rawBestLag = bestLag;
    for (var k = 2; k <= 6; k++) {
      var candidateLag = Math.round(rawBestLag / k);
      if (candidateLag < minLag) break;
      if (corrAtLag[candidateLag] >= acceptThreshold) {
        bestLag = candidateLag;
      }
    }

    var hz = sampleRate / bestLag;
    if (hz < MIN_HZ || hz > MAX_HZ) return null;
    return hz;
  }

  // startRecording(opts) -> Promise
  // opts.onAutoStop(trace) is called if MAX_DURATION_MS elapses before the
  // caller calls stopRecording() -- the caller should treat this exactly
  // like the learner tapping Stop (run mora-segment on the trace, re-enable
  // the Record button) since `state` is already cleared by the time this
  // fires: calling stopRecording() afterward is safe and just returns [].
  function startRecording(opts) {
    opts = opts || {};
    if (state) {
      return Promise.reject({ type: 'already-recording', message: 'A recording is already in progress.' });
    }
    if (!isSupported()) {
      return Promise.reject({ type: 'unsupported', message: 'Microphone recording is not supported in this browser.' });
    }

    // Reserve the slot SYNCHRONOUSLY, before the async getUserMedia call --
    // the `if (state)` check above only protects against a call made after
    // a previous recording has fully finished setup. Without this, two
    // overlapping startRecording() calls (e.g. one still waiting on the
    // mic-permission prompt while a second is triggered) would both observe
    // state === null and both proceed, each building an independent
    // capture pipeline with only the last one's `begin()` winning `state` --
    // orphaning the other's live mic stream/timers. Every path below that
    // can fail (getUserMedia rejection, ctx.resume() rejection) MUST reset
    // state back to null, or a single failed attempt would permanently wedge
    // every future startRecording() call behind 'already-recording'.
    state = { pending: true };

    return root.navigator.mediaDevices.getUserMedia({ audio: true }).then(
      function (stream) {
        var AudioCtx = root.AudioContext || root.webkitAudioContext;
        var ctx = new AudioCtx();
        var source = ctx.createMediaStreamSource(stream);
        var analyser = ctx.createAnalyser();
        analyser.fftSize = FRAME_SIZE; // fftSize sets the time-domain buffer length directly
        source.connect(analyser);

        var timeDomainBuf = new Float32Array(analyser.fftSize);
        var trace = [];
        var startTime = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        var intervalId = null;
        var stopTimeoutId = null;
        var stopped = false;

        function captureFrame() {
          if (stopped) return;
          analyser.getFloatTimeDomainData(timeDomainBuf);
          var hz = estimatePitch(timeDomainBuf, ctx.sampleRate);
          var tMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - startTime;
          trace.push({ tMs: tMs, hz: hz });
        }

        intervalId = setInterval(captureFrame, HOP_MS);
        stopTimeoutId = setTimeout(function () {
          // Auto-stop at MAX_DURATION_MS -- a normal path, not an error: the
          // spec's UI flow treats hitting the max duration the same as the
          // learner tapping Stop themselves, immediately followed by
          // analysis and (optionally) Retry. So this must NOT leave `state`
          // wedged non-null forever -- mark it auto-stopped and clear
          // `state` here rather than waiting for a stopRecording() call
          // that may never come (the caller who set up onAutoStop already
          // got the trace and moved on). Clear `state` BEFORE invoking the
          // caller's onAutoStop callback, not after: that callback runs the
          // caller's own code (app.js's handleTrace) synchronously, and if
          // it throws, a `state = null` placed after the call would never
          // run, wedging `state` non-null forever and permanently rejecting
          // every future startRecording() call with 'already-recording'.
          teardown();
          var onAutoStop = state && state.onAutoStop;
          state = null;
          if (onAutoStop) onAutoStop(trace.slice());
        }, MAX_DURATION_MS);

        function teardown() {
          if (stopped) return;
          stopped = true;
          if (intervalId !== null) clearInterval(intervalId);
          if (stopTimeoutId !== null) clearTimeout(stopTimeoutId);
          stream.getTracks().forEach(function (track) { track.stop(); });
          try { source.disconnect(); } catch (e) { /* ignore */ }
          try { ctx.close(); } catch (e) { /* ignore */ }
        }

        function begin() {
          state = {
            trace: trace,
            teardown: teardown,
            isStopped: function () { return stopped; },
            onAutoStop: typeof opts.onAutoStop === 'function' ? opts.onAutoStop : null,
          };
          return true;
        }

        // Some browsers create the AudioContext in a 'suspended' state
        // (autoplay-policy related) until explicitly resumed -- if we
        // resolve while suspended, getFloatTimeDomainData reads all zeros
        // and every frame comes back unvoiced even though the mic and
        // pitch estimator both work fine. Resume before telling the caller
        // "frame capture has begun".
        if (ctx.state === 'suspended') {
          return ctx.resume().then(
            function () { return begin(); },
            function (err) {
              // Release the reserved slot -- otherwise a rejected resume()
              // would leave `state` wedged as the {pending: true} placeholder
              // forever, permanently blocking every future startRecording()
              // call behind 'already-recording'.
              state = null;
              stream.getTracks().forEach(function (track) { track.stop(); });
              try { ctx.close(); } catch (e) { /* ignore */ }
              return Promise.reject({ type: 'unknown', message: (err && err.message) || 'Could not start recording.' });
            }
          );
        }
        return begin();
      },
      function (err) {
        // getUserMedia rejected -- release the reserved slot for the same
        // reason as the ctx.resume() rejection handler above.
        state = null;
        var name = err && err.name;
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
          return Promise.reject({ type: 'permission-denied', message: 'Microphone access was denied.' });
        }
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
          return Promise.reject({ type: 'no-device', message: 'No microphone was found.' });
        }
        return Promise.reject({ type: 'unknown', message: (err && err.message) || 'Could not start recording.' });
      }
    );
  }

  function stopRecording() {
    if (!state) return [];
    var trace = state.trace.slice();
    state.teardown();
    state = null;
    return trace;
  }

  return {
    isSupported: isSupported,
    unsupportedReason: unsupportedReason,
    startRecording: startRecording,
    stopRecording: stopRecording,
    // Exposed for testing the pure estimator against synthetic signals.
    _estimatePitch: estimatePitch,
    _FRAME_SIZE: FRAME_SIZE,
    _HOP_MS: HOP_MS,
    _MAX_DURATION_MS: MAX_DURATION_MS,
  };
});
