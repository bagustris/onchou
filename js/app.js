// app.js -- orchestrator wiring data/words.json + PitchDiagram + PitchDetect +
// MoraSegment + ReferenceAudio into the word-card UI described in the design
// spec's "UI flow" section. Owns DOM/state; every other js/*.js module is a
// pure or thin-wrapper dependency loaded before this file.
(function () {
  'use strict';

  var els = {
    unsupportedNotice: document.getElementById('unsupported-notice'),
    unsupportedNoticeText: document.getElementById('unsupported-notice-text'),
    quiz: document.getElementById('quiz'),
    wordText: document.getElementById('word-text'),
    wordReading: document.getElementById('word-reading'),
    targetDiagram: document.getElementById('target-diagram'),
    playBtn: document.getElementById('play-btn'),
    playBtnNote: document.getElementById('play-btn-note'),
    learnerDiagramRow: document.getElementById('learner-diagram-row'),
    learnerDiagram: document.getElementById('learner-diagram'),
    moraFeedback: document.getElementById('mora-feedback'),
    scoreText: document.getElementById('score-text'),
    detectMessage: document.getElementById('detect-message'),
    micMessage: document.getElementById('mic-message'),
    recIndicator: document.getElementById('rec-indicator'),
    recordBtn: document.getElementById('record-btn'),
    retryBtn: document.getElementById('retry-btn'),
    nextBtn: document.getElementById('next-btn'),
  };

  var words = [];
  var currentWord = null;
  var isRecording = false;
  // recordingActive covers the FULL span from clicking Record until
  // handleTrace() finishes processing -- including the async window where
  // startRecording()'s promise is still pending on the mic-permission
  // prompt, which isRecording (only set true once that promise resolves)
  // does not cover. Next/Play are disabled for this whole span so a word
  // switch can never happen mid-recording; recordingWord snapshots which
  // word the in-flight recording actually belongs to, so a race that still
  // somehow got through can't score a trace against the wrong word.
  var recordingActive = false;
  var recordingWord = null;
  // Set once (permanently) when no Japanese voice exists on this device at
  // all -- distinguishes that permanent condition from a transient per-click
  // playback failure, both of which write to els.playBtnNote (see
  // disablePlayButton and the Play click handler's .catch).
  var playPermanentlyUnavailable = false;

  function pickRandomWord() {
    if (!words.length) return null;
    return words[Math.floor(Math.random() * words.length)];
  }

  function moraCountFor(word) {
    return PitchDiagram.moraSplit(word.reading).length;
  }

  function targetLevelsFor(word) {
    return PitchDiagram.pitchLevels(moraCountFor(word), word.accentNum);
  }

  // Resets everything that reflects a previous recording attempt, without
  // touching which word is loaded -- used both when loading a brand-new
  // word and before a Retry re-recording.
  function resetAttemptUI() {
    els.learnerDiagramRow.hidden = true;
    els.learnerDiagram.innerHTML = '';
    els.moraFeedback.hidden = true;
    els.moraFeedback.innerHTML = '';
    els.scoreText.hidden = true;
    els.scoreText.textContent = '';
    els.detectMessage.hidden = true;
    els.micMessage.hidden = true;
    els.retryBtn.hidden = true;
    els.recordBtn.hidden = false;
    els.recordBtn.disabled = false;
    els.recordBtn.textContent = 'Record';
    // Only clear a TRANSIENT play-error note here -- a PERMANENT
    // "no Japanese voice on this device" note (see disablePlayButton) must
    // survive a word change, since that condition doesn't change per word
    // and the button stays disabled for the whole session; blindly clearing
    // playBtnNote on every word/retry would erase that explanation while
    // leaving the button visibly disabled with no reason shown.
    if (!playPermanentlyUnavailable) {
      els.playBtnNote.hidden = true;
      els.playBtnNote.textContent = '';
    }
  }

  function renderWord(word) {
    currentWord = word;
    els.wordText.textContent = word.word;
    els.wordReading.textContent = word.reading;
    var levels = targetLevelsFor(word);
    els.targetDiagram.innerHTML = PitchDiagram.renderSVG(levels, { variant: 'target' });
    resetAttemptUI();
  }

  function nextWord() {
    var word = pickRandomWord();
    if (word) renderWord(word);
  }

  // ---- Reference audio ("▶ Play") ----

  function setupReferenceAudio() {
    if (!ReferenceAudio.supported()) {
      disablePlayButton('speechSynthesis is not supported in this browser.');
      return;
    }
    ReferenceAudio.readyVoices().then(function () {
      if (!ReferenceAudio.hasJapaneseVoice()) {
        disablePlayButton('No Japanese voice found on this device/browser.');
      }
    });
    els.playBtn.addEventListener('click', function () {
      if (!currentWord) return;
      // Snapshot the reading synchronously at click time. readyVoices()
      // below can take up to VOICES_TIMEOUT_MS on a browser's first use
      // (the voice list loads asynchronously) -- without waiting for it,
      // an early click could call speak() while getVoices() still returns
      // [], producing a spurious "no Japanese voice found" error even on a
      // device that has one. Snapshotting `reading` (rather than reading
      // currentWord.reading again once the wait resolves) keeps this
      // playing the word that was current at click time even if the
      // learner has since moved to the next word.
      var reading = currentWord.reading;
      ReferenceAudio.readyVoices().then(function () {
        return ReferenceAudio.speak(reading);
      }).catch(function (err) {
        els.playBtnNote.hidden = false;
        els.playBtnNote.textContent = (err && err.message) || 'Could not play reference audio.';
      });
    });
  }

  function disablePlayButton(noteText) {
    playPermanentlyUnavailable = true;
    els.playBtn.disabled = true;
    els.playBtn.classList.add('disabled');
    els.playBtnNote.hidden = false;
    els.playBtnNote.textContent = noteText;
  }

  // ---- Recording / scoring ----

  function handleTrace(trace) {
    isRecording = false;
    recordingActive = false;
    els.recIndicator.hidden = true;
    els.recordBtn.textContent = 'Record';
    els.recordBtn.disabled = false;
    els.retryBtn.hidden = false;
    els.nextBtn.disabled = false;
    els.playBtn.disabled = playPermanentlyUnavailable;

    // Use the word this recording was actually FOR, snapshotted when
    // recording started -- not the live `currentWord`, which Next/Play
    // being disabled for the whole recordingActive span should normally
    // keep in sync anyway, but this is the belt-and-suspenders half of that
    // fix: even if some other path still let the word change mid-recording,
    // scoring stays correct rather than silently comparing against the
    // wrong word's pattern.
    var word = recordingWord || currentWord;
    recordingWord = null;
    var moraCount = moraCountFor(word);
    var segmented = MoraSegment.segmentByMora(trace, moraCount);
    var learnerPattern = segmented.pattern;

    var allUnclear = learnerPattern.length > 0 &&
      learnerPattern.every(function (p) { return p === 'unclear'; });
    if (allUnclear) {
      els.detectMessage.hidden = false;
      els.detectMessage.textContent = "Couldn't detect your voice clearly -- try again.";
      return;
    }

    var targetPattern = targetLevelsFor(word).slice(0, moraCount);
    var score = MoraSegment.scorePattern(learnerPattern, targetPattern);

    els.learnerDiagramRow.hidden = false;
    els.learnerDiagram.innerHTML = PitchDiagram.renderSVG(learnerPattern, {
      variant: 'learner',
      trailing: false,
    });

    els.moraFeedback.hidden = false;
    els.moraFeedback.innerHTML = score.perMora.map(function (status, i) {
      return '<span class="mora-chip ' + status + '">' + (i + 1) + '</span>';
    }).join('');

    els.scoreText.hidden = false;
    els.scoreText.textContent = score.matched + ' of ' + score.total + ' matched';
  }

  function startRecordingFlow() {
    resetAttemptUI();
    els.recordBtn.disabled = true;

    // Disable Next/Play for the WHOLE recording span, starting synchronously
    // right here -- not just after PitchDetect.startRecording()'s promise
    // resolves (isRecording only becomes true then). Without this, a click
    // on Next or Record during the async mic-permission-prompt window could
    // switch words while pitch-detect.js is still setting up the actual
    // capture for the old word.
    recordingActive = true;
    recordingWord = currentWord;
    els.nextBtn.disabled = true;
    els.playBtn.disabled = true;

    PitchDetect.startRecording({
      onAutoStop: function (trace) {
        handleTrace(trace);
      },
    }).then(function () {
      isRecording = true;
      els.recIndicator.hidden = false;
      els.recordBtn.disabled = false;
      els.recordBtn.textContent = 'Stop';
    }).catch(function (err) {
      isRecording = false;
      recordingActive = false;
      recordingWord = null;
      els.recIndicator.hidden = true;
      els.recordBtn.disabled = false;
      els.recordBtn.textContent = 'Record';
      els.nextBtn.disabled = false;
      els.playBtn.disabled = playPermanentlyUnavailable;
      if (err && err.type === 'permission-denied') {
        els.micMessage.hidden = false;
        els.micMessage.textContent = 'Microphone access is needed to practice pronunciation -- allow it and try again.';
      } else {
        els.micMessage.hidden = false;
        els.micMessage.textContent = (err && err.message) || 'Could not start recording.';
      }
    });
  }

  function setupRecording() {
    els.recordBtn.addEventListener('click', function () {
      if (isRecording) {
        var trace = PitchDetect.stopRecording();
        handleTrace(trace);
      } else {
        startRecordingFlow();
      }
    });

    els.retryBtn.addEventListener('click', function () {
      resetAttemptUI();
    });

    els.nextBtn.addEventListener('click', function () {
      // Belt-and-suspenders: the button is already disabled for the whole
      // recordingActive span (see startRecordingFlow/handleTrace), but
      // guard here too rather than relying solely on the disabled attribute
      // blocking the click.
      if (recordingActive) return;
      nextWord();
    });

    // Spacebar toggles Record/Stop from anywhere on the page, so the
    // learner doesn't need to re-aim the mouse at the button between every
    // take. Skipped when focus is already on a button/input -- the browser's
    // own spacebar-activates-focused-control behavior would fire first, and
    // also calling recordBtn.click() here would double-toggle it.
    document.addEventListener('keydown', function (e) {
      if (e.repeat || e.code !== 'Space') return;
      var tag = document.activeElement && document.activeElement.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (els.quiz.hidden || els.recordBtn.disabled) return;
      e.preventDefault();
      els.recordBtn.click();
    });
  }

  // ---- Boot ----

  // Distinct, accurate copy per PitchDetect.unsupportedReason() -- telling a
  // modern browser on an insecure origin to "try a recent browser" would be
  // wrong advice (switching browsers won't fix it) and would send the
  // learner on a pointless goose chase, so this must not collapse to one
  // generic message.
  var UNSUPPORTED_MESSAGES = {
    'insecure-context':
      'マイク録音には安全な接続が必要です。\n' +
      'Microphone recording requires a secure context. You’re viewing this page over an insecure connection (' +
      (typeof location !== 'undefined' ? location.protocol + '//' + location.host : '') +
      '). Use http://localhost (not an IP address or LAN hostname) when serving locally, or HTTPS when deployed.',
    'no-media-devices':
      'お使いのブラウザはマイク録音に対応していません。\n' +
      'This browser doesn’t support microphone recording, so onchou’s practice feature can’t run here. Try a recent Chrome, Firefox, Edge, or Safari.',
    'no-audio-context':
      'お使いのブラウザは音声解析に対応していません。\n' +
      'This browser doesn’t support the Web Audio API, so onchou can’t analyze your pitch. Try a recent Chrome, Firefox, Edge, or Safari.',
  };

  function boot() {
    var reason = PitchDetect.unsupportedReason();
    if (reason) {
      els.unsupportedNoticeText.textContent = UNSUPPORTED_MESSAGES[reason] || UNSUPPORTED_MESSAGES['no-media-devices'];
      els.unsupportedNotice.hidden = false;
      els.quiz.hidden = true;
      return;
    }

    els.quiz.hidden = false;
    els.recordBtn.disabled = true;
    setupReferenceAudio();
    setupRecording();

    fetch('data/words.json')
      .then(function (res) { return res.json(); })
      .then(function (data) {
        // A response that parses as JSON but isn't a non-empty array (an
        // empty `[]`, or a malformed shape) isn't caught by the .catch()
        // below, which only covers network/parse failures -- without this,
        // pickRandomWord() would quietly return null forever, Record would
        // stay enabled with no word loaded, and the first attempt would
        // throw inside handleTrace() (moraCountFor(null)) with no
        // user-visible message at all.
        words = Array.isArray(data) ? data : [];
        if (!words.length) {
          els.detectMessage.hidden = false;
          els.detectMessage.textContent = 'Could not load word data.';
          return;
        }
        nextWord();
        els.recordBtn.disabled = false;
      })
      .catch(function () {
        els.wordText.textContent = '';
        els.detectMessage.hidden = false;
        els.detectMessage.textContent = 'Could not load word data.';
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
