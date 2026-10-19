"use strict";

// CHECKOUT — a small browser-based supermarket sampler.
// No dependencies or build step required.

const SAMPLE_RATE = 44100;
const PAD_COUNT = 12;
const STEP_COUNT = 16;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_SECONDS = 0.12;

let bpm = 124;
let masterVolume = 0.8;
let activeBank = "CHECKOUT";
let selectedPad = null;
let isPlaying = false;
let isRecording = false;
let audioContext = null;
let masterGain = null;
let schedulerTimer = null;
let nextStepIndex = 0;
let nextStepTime = 0;
let displayedStep = -1;
let audioInitPromise = null;
const activeSources = new Set();

const bankNames = {
  CHECKOUT: ["SCAN", "SCAN+", "ERROR", "TILL", "COINS", "CASH", "PAPER", "PRINT", "TEAR", "BEEP", "DOOR", "HUM"],
  MONEY: ["COIN", "CHANGE", "NOTE", "COUNT", "DRAWER", "DROP", "CASH", "TILL", "PAPER", "CARD", "CHIME", "CLOSE"],
  STORE: ["CART", "WHEEL", "BAG", "FRIDGE", "FREEZER", "DOOR", "MOTOR", "FAN", "LIGHT", "AISLE", "HUM", "ROOM"],
  HUMAN: ["STEP", "VOICE", "COUGH", "LAUGH", "TALK", "SHOE", "CLOTH", "BAG", "MOVE", "DOOR", "ROOM", "AIR"]
};

const bankBuffers = Object.fromEntries(
  Object.keys(bankNames).map(name => [name, new Array(PAD_COUNT).fill(null)])
);
const bankSampleLabels = Object.fromEntries(
  Object.keys(bankNames).map(name => [name, new Array(PAD_COUNT).fill("BUILT-IN DEMO")])
);
const patterns = Object.fromEntries(
  Object.keys(bankNames).map(name => [
    name,
    Array.from({ length: PAD_COUNT }, () => new Array(STEP_COUNT).fill(false))
  ])
);

const el = {
  pads: document.getElementById("pads"),
  stepGrid: document.getElementById("stepGrid"),
  fileInput: document.getElementById("fileInput"),
  selectedPad: document.getElementById("selectedPad"),
  groupDisplay: document.getElementById("groupDisplay"),
  bpmDisplay: document.getElementById("bpmDisplay"),
  bpmOutput: document.getElementById("bpmOutput"),
  volumeOutput: document.getElementById("volumeOutput"),
  status: document.getElementById("statusDisplay"),
  play: document.getElementById("playButton"),
  record: document.getElementById("recordButton"),
  clear: document.getElementById("clearButton"),
  random: document.getElementById("randomButton"),
  export: document.getElementById("exportButton"),
  bpmSlider: document.getElementById("bpmSlider"),
  volumeSlider: document.getElementById("volumeSlider")
};

function setStatus(message) {
  el.status.textContent = message;
}

function currentPattern() {
  return patterns[activeBank];
}

function currentBuffers() {
  return bankBuffers[activeBank];
}

function currentLabels() {
  return bankSampleLabels[activeBank];
}

async function ensureAudio() {
  if (!audioInitPromise) {
    audioInitPromise = initializeAudio();
  }
  await audioInitPromise;
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }
}

async function initializeAudio() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) {
    audioInitPromise = null;
    throw new Error("This browser does not support the Web Audio API.");
  }
  audioContext = new AudioContextClass({ sampleRate: SAMPLE_RATE });
  masterGain = audioContext.createGain();
  masterGain.gain.value = masterVolume;
  masterGain.connect(audioContext.destination);
  createDemoLibrary();
}

function createDemoLibrary() {
  const definitions = {
    CHECKOUT: [
      [1850, .075, .10, .00], [2450, .055, .08, .00], [430, .14, .09, .18],
      [115, .28, .10, .15], [720, .09, .75, .55], [175, .22, .34, .45],
      [1200, .12, .70, .72], [760, .24, .55, .45], [2100, .055, .95, .8],
      [1320, .12, .13, .00], [190, .38, .75, .12], [53, 1.05, .16, .08]
    ],
    MONEY: [
      [950, .10, .80, .5], [570, .14, .6, .8], [210, .18, .45, .55],
      [160, .25, .45, .7], [110, .32, .15, .15], [820, .065, .75, .5],
      [260, .18, .35, .8], [95, .24, .14, .1], [1250, .10, .8, .6],
      [1400, .09, .1, .1], [990, .20, .2, .1], [75, .28, .3, .4]
    ],
    STORE: [
      [90, .30, .3, .4], [160, .18, .45, .6], [420, .15, .8, .8],
      [65, .62, .15, .08], [45, .95, .12, .08], [180, .42, .8, .12],
      [120, .45, .3, .6], [75, .75, .25, .65], [1400, .11, .4, .1],
      [250, .35, .6, .5], [52, 1.0, .12, .08], [320, .32, .25, .4]
    ],
    HUMAN: [
      [120, .14, .65, .7], [310, .25, .7, .65], [460, .12, .6, .9],
      [620, .22, .7, .7], [240, .28, .6, .85], [190, .11, .8, .55],
      [700, .17, .7, .9], [360, .16, .8, .85], [130, .19, .7, .55],
      [180, .40, .65, .2], [280, .23, .55, .7], [75, .65, .18, .3]
    ]
  };

  for (const [bank, definitionsForBank] of Object.entries(definitions)) {
    definitionsForBank.forEach((definition, padIndex) => {
      const [frequency, duration, decay, noise] = definition;
      bankBuffers[bank][padIndex] = makeDemoBuffer(frequency, duration, decay, noise, bank, padIndex);
      bankSampleLabels[bank][padIndex] = "BUILT-IN DEMO";
    });
  }
}

function makeDemoBuffer(frequency, duration, decay, noiseAmount, bank, padIndex) {
  const length = Math.max(1, Math.floor(SAMPLE_RATE * duration));
  const buffer = audioContext.createBuffer(1, length, SAMPLE_RATE);
  const data = buffer.getChannelData(0);
  const bankOffset = Object.keys(bankNames).indexOf(bank) * 0.37;
  let peak = 0;

  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    const envelope = Math.exp(-(1.5 + decay * 13) * t);
    const transient = Math.exp(-t * 55);
    const fundamental = Math.sin(2 * Math.PI * frequency * t + bankOffset);
    const harmonic = Math.sin(2 * Math.PI * frequency * (1.47 + padIndex * 0.025) * t) * 0.28;
    const grit = (Math.random() * 2 - 1) * noiseAmount * transient;
    let sample = (fundamental + harmonic) * envelope + grit;
    if (padIndex === 11 && bank === "STORE") {
      sample = (fundamental * 0.2 + (Math.random() * 2 - 1) * 0.08) * (0.35 + 0.65 * Math.exp(-t * 1.1));
    }
    data[i] = sample;
    peak = Math.max(peak, Math.abs(sample));
  }

  const scale = peak > 0 ? 0.68 / peak : 1;
  for (let i = 0; i < length; i++) data[i] *= scale;
  return buffer;
}

function renderPads() {
  el.pads.innerHTML = "";
  bankNames[activeBank].forEach((name, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pad";
    button.dataset.pad = String(index);
    button.innerHTML = `
      <span class="pad-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="pad-name"></span>
      <span class="pad-file"></span>
    `;
    button.querySelector(".pad-name").textContent = name;
    button.querySelector(".pad-file").textContent = currentLabels()[index];
    button.addEventListener("click", () => handlePadTrigger(index));
    el.pads.appendChild(button);
  });
  if (selectedPad !== null) {
    const button = el.pads.querySelector(`[data-pad="${selectedPad}"]`);
    if (button) button.classList.add("selected");
  }
}

function renderSequencer() {
  el.stepGrid.innerHTML = "";
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    const row = document.createElement("div");
    row.className = "step-row";
    const label = document.createElement("span");
    label.className = "step-row-label";
    label.textContent = `${String(pad + 1).padStart(2, "0")} ${bankNames[activeBank][pad]}`;
    row.appendChild(label);

    for (let step = 0; step < STEP_COUNT; step++) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = "step";
      cell.setAttribute("aria-label", `Pad ${pad + 1}, step ${step + 1}`);
      cell.dataset.pad = String(pad);
      cell.dataset.step = String(step);
      cell.addEventListener("click", () => {
        const pattern = currentPattern();
        pattern[pad][step] = !pattern[pad][step];
        updateStepCell(pad, step);
      });
      row.appendChild(cell);
    }
    el.stepGrid.appendChild(row);
  }
  refreshAllSteps();
  if (displayedStep >= 0) highlightStep(displayedStep);
}

function updateStepCell(pad, step) {
  const cell = el.stepGrid.querySelector(`.step-row:nth-child(${pad + 1}) .step:nth-child(${step + 2})`);
  if (cell) cell.classList.toggle("on", currentPattern()[pad][step]);
}

function refreshAllSteps() {
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    for (let step = 0; step < STEP_COUNT; step++) updateStepCell(pad, step);
  }
}

function highlightStep(step) {
  el.stepGrid.querySelectorAll(".step.current").forEach(cell => cell.classList.remove("current"));
  displayedStep = step;
  if (step < 0) return;
  el.stepGrid.querySelectorAll(`.step[data-step="${step}"]`).forEach(cell => cell.classList.add("current"));
}

function setSelectedPad(index) {
  selectedPad = index;
  el.pads.querySelectorAll(".pad").forEach(pad => {
    pad.classList.toggle("selected", Number(pad.dataset.pad) === index);
  });
  el.selectedPad.textContent = `${String(index + 1).padStart(2, "0")} — ${bankNames[activeBank][index]}`;
}

async function handlePadTrigger(index) {
  try {
    await ensureAudio();
    setSelectedPad(index);
    playBuffer(index, audioContext.currentTime);
    if (isRecording) {
      if (isPlaying && displayedStep >= 0) {
        currentPattern()[index][displayedStep] = true;
        updateStepCell(index, displayedStep);
        setStatus("REC + PLAY");
      } else {
        setStatus("REC ARMED · PRESS PLAY");
      }
    }
  } catch (error) {
    console.error(error);
    setStatus("AUDIO ERROR");
    alert(error.message || "Audio could not be initialized.");
  }
}

function playBuffer(index, when = null, bank = activeBank, destinationContext = audioContext, destinationGain = masterGain) {
  const buffer = bankBuffers[bank][index];
  if (!buffer || !destinationContext || !destinationGain) return;
  const source = destinationContext.createBufferSource();
  const gain = destinationContext.createGain();
  source.buffer = buffer;
  gain.gain.value = 1;
  source.connect(gain);
  gain.connect(destinationGain);
  source.onended = () => activeSources.delete(source);
  activeSources.add(source);
  source.start(when === null ? destinationContext.currentTime : when);
  return source;
}

function stepDurationSeconds() {
  return 60 / bpm / 4;
}

function scheduleStep(step, when) {
  const pattern = currentPattern();
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    if (pattern[pad][step]) playBuffer(pad, when);
  }
  const delay = Math.max(0, (when - audioContext.currentTime) * 1000);
  window.setTimeout(() => {
    if (isPlaying) highlightStep(step);
  }, delay);
}

function scheduler() {
  if (!isPlaying || !audioContext) return;
  while (nextStepTime < audioContext.currentTime + SCHEDULE_AHEAD_SECONDS) {
    scheduleStep(nextStepIndex, nextStepTime);
    nextStepTime += stepDurationSeconds();
    nextStepIndex = (nextStepIndex + 1) % STEP_COUNT;
  }
  schedulerTimer = window.setTimeout(scheduler, LOOKAHEAD_MS);
}

async function togglePlayback() {
  try {
    await ensureAudio();
    isPlaying = !isPlaying;
    if (isPlaying) {
      nextStepIndex = 0;
      nextStepTime = audioContext.currentTime + 0.05;
      el.play.textContent = "■ STOP";
      setStatus(isRecording ? "REC + PLAY" : "PLAYING");
      scheduler();
    } else {
      window.clearTimeout(schedulerTimer);
      el.play.textContent = "▶ PLAY";
      stopActiveSources();
      highlightStep(-1);
      setStatus(isRecording ? "REC ARMED" : "STANDBY");
    }
  } catch (error) {
    console.error(error);
    setStatus("AUDIO ERROR");
    alert(error.message || "Audio could not be initialized.");
  }
}

function stopActiveSources() {
  for (const source of activeSources) {
    try { source.stop(); } catch (_) { /* already stopped */ }
  }
  activeSources.clear();
}

function toggleRecording() {
  isRecording = !isRecording;
  el.record.classList.toggle("active", isRecording);
  if (isRecording) setStatus(isPlaying ? "REC + PLAY" : "REC ARMED · PRESS PLAY");
  else setStatus(isPlaying ? "PLAYING" : "STANDBY");
}

function clearPattern() {
  currentPattern().forEach(row => row.fill(false));
  refreshAllSteps();
  setStatus("PATTERN CLEARED");
}

function randomPattern() {
  clearPattern();
  const pattern = currentPattern();
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    const probability = pad === 11 ? 0.08 : 0.12 + Math.random() * 0.16;
    for (let step = 0; step < STEP_COUNT; step++) {
      if (Math.random() < probability) pattern[pad][step] = true;
    }
  }
  pattern[0][0] = true;
  pattern[0][8] = true;
  pattern[3][4] = true;
  pattern[7][12] = true;
  refreshAllSteps();
  setStatus("PATTERN GENERATED");
}

function switchBank(bank) {
  if (!bankNames[bank]) return;
  activeBank = bank;
  selectedPad = null;
  el.selectedPad.textContent = "NONE";
  el.groupDisplay.textContent = bank;
  document.querySelectorAll(".bank-tab").forEach(tab => {
    tab.classList.toggle("active", tab.dataset.group === bank);
  });
  renderPads();
  renderSequencer();
  setStatus(isPlaying ? "PLAYING" : "STANDBY");
}

async function loadSample(file) {
  if (selectedPad === null) {
    alert("Select a pad first, then load your audio file.");
    return;
  }
  try {
    await ensureAudio();
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    bankBuffers[activeBank][selectedPad] = decoded;
    bankSampleLabels[activeBank][selectedPad] = file.name;
    const pad = el.pads.querySelector(`[data-pad="${selectedPad}"]`);
    if (pad) pad.querySelector(".pad-file").textContent = file.name;
    setStatus("SAMPLE LOADED");
    await playBuffer(selectedPad, audioContext.currentTime);
  } catch (error) {
    console.error(error);
    setStatus("LOAD ERROR");
    alert("Could not read this audio file. Try a WAV file encoded as PCM.");
  } finally {
    el.fileInput.value = "";
  }
}

async function exportWav() {
  try {
    await ensureAudio();
    setStatus("RENDERING");
    el.export.disabled = true;
    const stepTime = stepDurationSeconds();
    const frameCount = Math.max(1, Math.ceil(STEP_COUNT * stepTime * SAMPLE_RATE));
    const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OfflineContext) throw new Error("Offline audio rendering is not supported by this browser.");
    const offline = new OfflineContext(2, frameCount, SAMPLE_RATE);
    const outputGain = offline.createGain();
    outputGain.gain.value = masterVolume;
    outputGain.connect(offline.destination);
    const pattern = currentPattern();

    for (let step = 0; step < STEP_COUNT; step++) {
      const when = step * stepTime;
      for (let pad = 0; pad < PAD_COUNT; pad++) {
        if (!pattern[pad][step]) continue;
        const buffer = bankBuffers[activeBank][pad];
        if (!buffer) continue;
        const source = offline.createBufferSource();
        source.buffer = buffer;
        source.connect(outputGain);
        source.start(when);
      }
    }

    const rendered = await offline.startRendering();
    const wav = encodeWav16Stereo(rendered);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `checkout-${activeBank.toLowerCase()}-pattern.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    setStatus("WAV EXPORTED");
  } catch (error) {
    console.error(error);
    setStatus("EXPORT ERROR");
    alert(error.message || "Could not export WAV.");
  } finally {
    el.export.disabled = false;
  }
}

function encodeWav16Stereo(audioBuffer) {
  const channels = 2;
  const sampleRate = audioBuffer.sampleRate;
  const frames = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  function writeString(offset, text) {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const left = audioBuffer.getChannelData(0);
  const right = audioBuffer.getChannelData(1);
  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (const data of [left, right]) {
      const sample = Math.max(-1, Math.min(1, data[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }
  return buffer;
}

function updateTempo(value) {
  bpm = Number(value);
  el.bpmDisplay.textContent = `${bpm} BPM`;
  document.getElementById("bpmOutput").textContent = `${bpm} BPM`;
}

function updateVolume(value) {
  masterVolume = Number(value);
  el.volumeOutput.textContent = `${Math.round(masterVolume * 100)}%`;
  if (masterGain) masterGain.gain.setTargetAtTime(masterVolume, audioContext.currentTime, 0.01);
}

const keyboardPads = { q: 0, w: 1, e: 2, a: 3, s: 4, d: 5, z: 6, x: 7, c: 8, "1": 9, "2": 10, "3": 11 };

document.querySelectorAll(".bank-tab").forEach(button => {
  button.addEventListener("click", () => switchBank(button.dataset.group));
});
el.play.addEventListener("click", togglePlayback);
el.record.addEventListener("click", toggleRecording);
el.clear.addEventListener("click", clearPattern);
el.random.addEventListener("click", randomPattern);
el.export.addEventListener("click", exportWav);
el.bpmSlider.addEventListener("input", event => updateTempo(event.target.value));
el.volumeSlider.addEventListener("input", event => updateVolume(event.target.value));
el.fileInput.addEventListener("change", event => {
  const file = event.target.files && event.target.files[0];
  if (file) loadSample(file);
});

document.addEventListener("keydown", event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  const key = event.key.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(keyboardPads, key)) {
    event.preventDefault();
    handlePadTrigger(keyboardPads[key]);
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
  } else if (key === "r") {
    toggleRecording();
  } else if (key === "e") {
    exportWav();
  }
});

renderPads();
renderSequencer();
updateTempo(el.bpmSlider.value);
updateVolume(el.volumeSlider.value);
