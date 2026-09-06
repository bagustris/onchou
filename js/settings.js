// settings.js -- user preferences (auto-play, etc.), persisted to their own
// localStorage entry, separate from any future learning-progress storage so
// the two can be reset independently. Thin localStorage wrapper with no
// meaningful pure logic beyond merging defaults, so (matching this
// codebase's own testing convention of unit-testing pure/DOM-free logic,
// not framework wrappers) it has no test file -- verified manually
// in-browser, same as js/reference-audio.js's live speechSynthesis calls.
var SettingsManager = (function () {
  'use strict';

  var STORAGE_KEY = 'onchou-settings';
  // autoPlayReference defaults to false: the learner taps "Play" to hear
  // the reference on their own schedule by default; turning this on speaks
  // it automatically as soon as a new word loads.
  // showContour defaults to false: the raw F0 contour graph is an advanced/
  // supplementary view alongside the primary per-mora H/L diagrams, hidden
  // until a learner opts in.
  // level defaults to 'all' (see js/word-select.js's LEVELS): an existing
  // learner who never opens Settings keeps seeing every word length they
  // always have, rather than being silently restricted to 2-mora words by
  // an update.
  var DEFAULTS = { autoPlayReference: false, showContour: false, level: 'all' };

  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return Object.assign({}, DEFAULTS);
      return Object.assign({}, DEFAULTS, JSON.parse(raw));
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }

  function save(settings) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      // localStorage unavailable (private mode, quota, etc.) -- fail silently
    }
  }

  function get(key) {
    return load()[key];
  }

  function set(key, value) {
    var settings = load();
    settings[key] = value;
    save(settings);
  }

  return { get: get, set: set };
})();
