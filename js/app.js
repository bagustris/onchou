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
    contourRow: document.getElementById('contour-row'),
    contourGraph: document.getElementById('contour-graph'),
    moraFeedback: document.getElementById('mora-feedback'),
    scoreText: document.getElementById('score-text'),
    detectMessage: document.getElementById('detect-message'),
    micMessage: document.getElementById('mic-message'),
    recIndicator: document.getElementById('rec-indicator'),
    recordBtn: document.getElementById('record-btn'),
    retryBtn: document.getElementById('retry-btn'),
    nextBtn: document.getElementById('next-btn'),
    btnSettings: document.getElementById('btn-settings'),
    btnSettingsClose: document.getElementById('btn-settings-close'),
    settingsOverlay: document.getElementById('settings-overlay'),
    settingsPanel: document.getElementById('settings-panel'),
    settingAutoPlay: document.getElementById('setting-auto-play'),
    settingShowContour: document.getElementById('setting-show-contour'),
    settingLevelButtons: Array.prototype.slice.call(
      document.querySelectorAll('#setting-level .segmented-btn')
    ),
    installButton: document.getElementById('btn-install'),
    installHint: document.getElementById('settings-install-hint'),
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

  // Selection is delegated to js/word-select.js: the learner's chosen level
  // caps word length, and the pick is balanced across whichever accent
  // patterns that level makes available (heiban otherwise dominates the
  // pool -- see that module's header and the learning-progression design
  // spec).
  function pickNextWord() {
    return WordSelect.pickWord(words, SettingsManager.get('level'));
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
    els.contourRow.hidden = true;
    els.contourGraph.innerHTML = '';
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
    if (SettingsManager.get('autoPlayReference')) playReference();
  }

  function nextWord() {
    var word = pickNextWord();
    if (word) {
      renderWord(word);
      return;
    }
    // No word survived the level filter. Can't happen with the shipped
    // data/words.json (the narrowest level, "2", still has 291 words), but
    // silently doing nothing on a "Next word" tap would be a dead-end with
    // no explanation if that ever changed -- say so instead.
    els.detectMessage.hidden = false;
    els.detectMessage.textContent = 'No words available at this practice level -- widen it in Settings.';
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
      playReference();
    });
  }

  // Speaks the current word's reading -- shared by the "▶ Play" button and,
  // when the auto-play setting is on, renderWord()'s new-word path. Snapshots
  // `reading` synchronously at call time rather than re-reading
  // currentWord.reading once readyVoices() resolves: readyVoices() can take
  // up to VOICES_TIMEOUT_MS on a browser's first use (the voice list loads
  // asynchronously), and without a snapshot a word change during that wait
  // could end up speaking the wrong word.
  function playReference() {
    if (!currentWord) return;
    var reading = currentWord.reading;
    ReferenceAudio.readyVoices().then(function () {
      return ReferenceAudio.speak(reading);
    }).catch(function (err) {
      els.playBtnNote.hidden = false;
      els.playBtnNote.textContent = (err && err.message) || 'Could not play reference audio.';
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

    var fullTargetLevels = targetLevelsFor(word);
    var targetPattern = fullTargetLevels.slice(0, moraCount);
    var score = MoraSegment.scorePattern(learnerPattern, targetPattern);

    // Append a trailing hollow dot to the learner diagram too, mirroring the
    // TARGET's trailing level -- purely for visual alignment with the
    // target diagram above it (same dot count, same x-positions), not a
    // claim about anything actually measured. The mic recording stops at
    // the word itself, so there's no real detected pitch for whatever comes
    // after it (see docs/2026-09-05-pitch-accent-evaluation-research-plan.md
    // for the future-data-collection note this gap motivates).
    var trailingLevel = fullTargetLevels[fullTargetLevels.length - 1];
    els.learnerDiagramRow.hidden = false;
    els.learnerDiagram.innerHTML = PitchDiagram.renderSVG(learnerPattern.concat([trailingLevel]), {
      variant: 'learner',
    });

    if (SettingsManager.get('showContour')) {
      els.contourRow.hidden = false;
      els.contourGraph.innerHTML = PitchContour.renderSVG(trace, fullTargetLevels, segmented);
    }

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

  // ---- Settings dialog ----
  //
  // A plain modal (backdrop click / Escape / close button dismiss it)
  // rather than a full focus trap -- reached by mouse/touch or Tab, same
  // scope jlpt/kotoba/jed/wanikanji's own settings dialogs use.

  function openSettings() {
    els.settingsOverlay.hidden = false;
    renderInstallRow();
    els.btnSettingsClose.focus();
  }

  function closeSettings() {
    els.settingsOverlay.hidden = true;
    els.btnSettings.focus();
  }

  // PWA install: Chrome/Edge/Android fire `beforeinstallprompt`, which is
  // stashed until the learner opens Settings. Browsers with no such event
  // (iOS Safari, desktop Safari/Firefox) get a manual "Add to Home Screen"
  // hint instead, since there's no install API to call there.
  var deferredInstallPrompt = null;

  function isStandaloneDisplay() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function renderInstallRow() {
    if (isStandaloneDisplay()) {
      els.installButton.hidden = true;
      els.installHint.textContent = 'インストール済み — Already installed';
      els.installHint.hidden = false;
      return;
    }
    if (deferredInstallPrompt) {
      els.installButton.hidden = false;
      els.installHint.hidden = true;
      return;
    }
    els.installButton.hidden = true;
    var isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    els.installHint.textContent = isIOS
      ? '共有ボタン → ホーム画面に追加 — Share button → Add to Home Screen'
      : 'ブラウザメニューの「インストール」から追加できます — Use your browser menu → Install app';
    els.installHint.hidden = false;
  }

  // Reflects the stored level on the segmented control. Also used at setup
  // time, so the markup's hardcoded `.active` (on "All", the default) is
  // corrected to whatever the learner actually chose last session.
  function syncLevelButtons() {
    var level = SettingsManager.get('level');
    els.settingLevelButtons.forEach(function (btn) {
      var active = btn.dataset.value === level;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  function setupSettingsPanel() {
    els.btnSettings.addEventListener('click', openSettings);
    els.btnSettingsClose.addEventListener('click', closeSettings);
    els.settingsOverlay.addEventListener('click', function (e) {
      if (e.target === els.settingsOverlay) closeSettings();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.settingsOverlay.hidden) closeSettings();
    });

    els.settingAutoPlay.checked = SettingsManager.get('autoPlayReference');
    els.settingAutoPlay.addEventListener('change', function () {
      SettingsManager.set('autoPlayReference', els.settingAutoPlay.checked);
    });

    els.settingShowContour.checked = SettingsManager.get('showContour');
    els.settingShowContour.addEventListener('change', function () {
      SettingsManager.set('showContour', els.settingShowContour.checked);
      // Take effect immediately on the attempt already on screen, not just
      // the next recording -- turning it off should hide it right away,
      // and turning it on should reveal it if a trace has already been
      // scored (contourGraph.innerHTML is only ever populated when a
      // completed attempt exists, so an empty one here is never mistaken
      // for "should be showing").
      if (!els.settingShowContour.checked) {
        els.contourRow.hidden = true;
      } else if (els.contourGraph.innerHTML) {
        els.contourRow.hidden = false;
      }
    });

    syncLevelButtons();
    els.settingLevelButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        SettingsManager.set('level', btn.dataset.value);
        syncLevelButtons();
        // Deliberately does NOT re-pick the current word -- the new level
        // applies from the next "Next word" on, matching how the auto-play
        // and pitch-curve settings above also only affect what happens
        // next rather than rewriting what's already on screen.
      });
    });

    els.installButton.addEventListener('click', function () {
      if (!deferredInstallPrompt) return;
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.then(function () {
        deferredInstallPrompt = null;
        renderInstallRow();
      });
    });

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferredInstallPrompt = e;
      renderInstallRow();
    });
    window.addEventListener('appinstalled', function () {
      deferredInstallPrompt = null;
      renderInstallRow();
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
    // Independent of mic/Web Audio support -- the settings dialog (install
    // prompt, auto-play toggle) works the same whether or not the quiz UI
    // below is available.
    setupSettingsPanel();

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
        // pickNextWord() would quietly return null forever, Record would
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
