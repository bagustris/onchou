// wav-reader.js -- minimal, dependency-free PCM WAV decoder for
// tools/evaluate-jsut-accuracy.js. Only handles what JSUT's own files
// actually are (confirmed via `soxi`: mono, 16-bit signed PCM, 48kHz,
// uncompressed 'fmt ' chunk) -- not a general-purpose WAV library. No
// npm dependency, consistent with every other tools/*.js script in this
// repo (there is no package.json at all).
'use strict';

const fs = require('fs');

// readWavSync(filePath) -> { sampleRate, channels, bitDepth, samples: Float32Array }
// samples are de-interleaved-if-mono, normalized to [-1, 1] -- the same
// range js/pitch-detect.js's estimatePitch expects (it's fed
// AnalyserNode.getFloatTimeDomainData output in the browser, which is
// always in that range).
function readWavSync(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${filePath}: not a RIFF/WAVE file`);
  }

  let offset = 12;
  let fmt = null;
  let dataStart = -1;
  let dataLength = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;

    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(bodyStart),
        channels: buf.readUInt16LE(bodyStart + 2),
        sampleRate: buf.readUInt32LE(bodyStart + 4),
        bitDepth: buf.readUInt16LE(bodyStart + 14),
      };
    } else if (chunkId === 'data') {
      dataStart = bodyStart;
      dataLength = chunkSize;
    }

    // Chunks are word-aligned: an odd chunkSize has one padding byte after it.
    offset = bodyStart + chunkSize + (chunkSize % 2);
  }

  if (!fmt) throw new Error(`${filePath}: no fmt chunk found`);
  if (dataStart < 0) throw new Error(`${filePath}: no data chunk found`);
  if (fmt.audioFormat !== 1) throw new Error(`${filePath}: only uncompressed PCM is supported (audioFormat=${fmt.audioFormat})`);
  if (fmt.bitDepth !== 16) throw new Error(`${filePath}: only 16-bit PCM is supported (bitDepth=${fmt.bitDepth})`);

  const frameCount = Math.floor(dataLength / (2 * fmt.channels));
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    // Mono only (JSUT is mono) -- first channel of each frame if not.
    const sampleOffset = dataStart + i * fmt.channels * 2;
    samples[i] = buf.readInt16LE(sampleOffset) / 32768;
  }

  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitDepth: fmt.bitDepth, samples: samples };
}

module.exports = { readWavSync };
