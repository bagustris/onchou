// Reference audio via window.speechSynthesis -- the "▶ Play" button's
// backing module. Offline-first browser TTS only: unlike
// ai-pronunciation-trainer (which falls back to a server-side sherox
// model when no on-device voice is found), onchou has no server at all,
// so a missing Japanese voice means the button stays disabled with an
// inline note rather than speaking in the wrong language or silently
// failing. Pure helpers (voice filtering/ranking) also run in Node for
// testing; the live speechSynthesis calls are browser-only.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReferenceAudio = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Feature-detect window.speechSynthesis entirely -- some old/unusual
  // browsers lack it outright, distinct from "supported but no ja voice".
  function supported() {
    return typeof self !== 'undefined' && !!self.speechSynthesis
      && typeof self.SpeechSynthesisUtterance !== 'undefined';
  }

  // Pure predicate, exported for testing: does this voice speak Japanese?
  // BCP-47 language tags for Japanese are always 'ja' or 'ja-XX', so a
  // prefix match on 'ja' is correct and doesn't need a locale library.
  function isJapaneseVoice(v) {
    return !!(v && v.lang && v.lang.startsWith('ja'));
  }

  // Ranks candidate Japanese voices best-first: prefer an on-device
  // (localService=true) voice -- works offline, matches this app's
  // fully-static/serverless requirement in spirit -- before falling back
  // to a network voice (e.g. Chrome's remote "Google" voices), which will
  // silently fail without internet. Mirrors the localService-first search
  // order ai-pronunciation-trainer's offline-first mode uses, minus its
  // server-side fallback tier (onchou has none).
  function pickJapaneseVoice(voices) {
    const candidates = (voices || []).filter(isJapaneseVoice);
    if (candidates.length === 0) return null;
    const local = candidates.find(v => v.localService);
    return local || candidates[0];
  }

  function hasJapaneseVoice() {
    if (!supported()) return false;
    return pickJapaneseVoice(self.speechSynthesis.getVoices()) !== null;
  }

  // getVoices() can return [] on first call, before the browser has
  // finished loading its voice list asynchronously (most noticeable on
  // Chrome). readyVoices() gives callers a Promise to await instead of
  // racing: resolves immediately if voices are already loaded, otherwise
  // waits for one 'voiceschanged' event (with a timeout safety net, in
  // case a browser never fires it) and re-checks.
  const VOICES_TIMEOUT_MS = 2000;
  function readyVoices() {
    if (!supported()) return Promise.resolve([]);
    const synth = self.speechSynthesis;
    const existing = synth.getVoices();
    if (existing.length > 0) return Promise.resolve(existing);

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        synth.removeEventListener('voiceschanged', onVoicesChanged);
        clearTimeout(timer);
        resolve(synth.getVoices());
      };
      const onVoicesChanged = () => finish();
      synth.addEventListener('voiceschanged', onVoicesChanged);
      const timer = setTimeout(finish, VOICES_TIMEOUT_MS);
    });
  }

  // Speaks `reading` (a kana string) with a ja-* voice. Never speaks in
  // the wrong language: rejects with a clear reason if unsupported or if
  // no Japanese voice is available at call time, rather than silently
  // no-op'ing or falling back to whatever the default voice is.
  function speak(reading) {
    if (!supported()) {
      return Promise.reject(new Error('speechSynthesis is not supported in this browser'));
    }
    const synth = self.speechSynthesis;
    const voice = pickJapaneseVoice(synth.getVoices());
    if (!voice) {
      return Promise.reject(new Error('no Japanese voice found on this device/browser'));
    }
    return new Promise((resolve, reject) => {
      const utterance = new self.SpeechSynthesisUtterance(reading);
      utterance.voice = voice;
      utterance.lang = voice.lang;
      utterance.onend = () => resolve();
      utterance.onerror = (e) => {
        // 'canceled'/'interrupted' aren't failures -- they're what the
        // browser reports when something (a word change, or the start of a
        // recording, both of which call cancel() below so the mic doesn't
        // pick up the TTS) deliberately stopped this utterance. Rejecting
        // them would surface "canceled" to the learner as a playback error
        // note under the Play button.
        const reason = e && e.error;
        if (reason === 'canceled' || reason === 'interrupted') return resolve();
        reject(reason ? new Error(reason) : e);
      };
      // A fresh utterance per call (never reused) -- SpeechSynthesisUtterance
      // instances are single-use in every implementation.
      synth.speak(utterance);
    });
  }

  // Stops anything currently being spoken (and clears the queue). Needed
  // before recording starts -- an in-flight reference utterance would
  // otherwise be picked up by the microphone and analyzed as if it were the
  // learner's own voice -- and on a word change, so a queued utterance for
  // the previous word can't speak over the new one.
  function cancel() {
    if (!supported()) return;
    try { self.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
  }

  return { supported, hasJapaneseVoice, readyVoices, speak, cancel, isJapaneseVoice, pickJapaneseVoice };
});
