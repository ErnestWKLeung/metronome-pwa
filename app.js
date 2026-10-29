(() => {
  "use strict";

  const BPM_MIN = 40;
  const BPM_MAX = 240;
  const BPM_DEFAULT = 120;

  const state = {
    bpm: BPM_DEFAULT,
    beatsPerBar: 4,
    beatUnit: 4, // denominator; 6/8 → eighth-note pulse
    playing: false,
    beatIndex: 0,
    nextNoteTime: 0,
    timerId: null,
    audioCtx: null,
    silentGain: null,
    silentOsc: null,
    wakeLock: null,
    tapTimes: [],
  };

  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.12;

  const el = {
    bpmValue: document.getElementById("bpm-value"),
    bpmSlider: document.getElementById("bpm-slider"),
    bpmUp: document.getElementById("bpm-up"),
    bpmDown: document.getElementById("bpm-down"),
    bpmUp5: document.getElementById("bpm-up-5"),
    bpmDown5: document.getElementById("bpm-down-5"),
    tap: document.getElementById("tap-tempo"),
    playStop: document.getElementById("play-stop"),
    playStopLabel: document.getElementById("play-stop-label"),
    beatDots: document.getElementById("beat-dots"),
    meters: Array.from(document.querySelectorAll(".btn-meter")),
  };

  function clampBpm(n) {
    return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(n)));
  }

  function pulseSeconds() {
    // Beat length in seconds for current pulse (quarter for /4, eighth for /8)
    const quartersPerMinute = state.bpm;
    const quarterSec = 60 / quartersPerMinute;
    if (state.beatUnit === 8) return quarterSec / 2;
    return quarterSec;
  }

  function ensureAudio() {
    if (!state.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      state.audioCtx = new AC();
    }
    if (state.audioCtx.state === "suspended") {
      state.audioCtx.resume().catch(() => {});
    }
    return state.audioCtx;
  }

  /** Best-effort silent keep-alive for iOS (does not guarantee background audio). */
  function startSilentKeepAlive() {
    const ctx = ensureAudio();
    stopSilentKeepAlive();
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.frequency.value = 1;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      state.silentOsc = osc;
      state.silentGain = gain;
    } catch (_) {
      /* ignore */
    }
  }

  function stopSilentKeepAlive() {
    try {
      if (state.silentOsc) {
        state.silentOsc.stop();
        state.silentOsc.disconnect();
      }
      if (state.silentGain) state.silentGain.disconnect();
    } catch (_) {
      /* ignore */
    }
    state.silentOsc = null;
    state.silentGain = null;
  }

  async function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    } catch (_) {
      state.wakeLock = null;
    }
  }

  async function releaseWakeLock() {
    try {
      if (state.wakeLock) await state.wakeLock.release();
    } catch (_) {
      /* ignore */
    }
    state.wakeLock = null;
  }

  /**
   * Synthesize a short click. Strong beat = higher pitch + louder.
   */
  function scheduleClick(time, isStrong) {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    const freq = isStrong ? 1200 : 800;
    const peak = isStrong ? 0.55 : 0.28;
    const dur = isStrong ? 0.045 : 0.03;

    osc.type = "square";
    osc.frequency.setValueAtTime(freq, time);

    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(time);
    osc.stop(time + dur + 0.01);
  }

  function scheduleVisual(beatIndex, when) {
    const delay = Math.max(0, (when - ensureAudio().currentTime) * 1000);
    setTimeout(() => {
      if (!state.playing) return;
      highlightBeat(beatIndex);
    }, delay);
  }

  function highlightBeat(index) {
    const dots = el.beatDots.querySelectorAll(".beat-dot");
    dots.forEach((d, i) => {
      d.classList.toggle("is-active", i === index);
    });
  }

  function scheduler() {
    if (!state.playing) return;
    const ctx = ensureAudio();
    while (state.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const isStrong = state.beatIndex === 0;
      scheduleClick(state.nextNoteTime, isStrong);
      scheduleVisual(state.beatIndex, state.nextNoteTime);
      state.nextNoteTime += pulseSeconds();
      state.beatIndex = (state.beatIndex + 1) % state.beatsPerBar;
    }
    state.timerId = setTimeout(scheduler, LOOKAHEAD_MS);
  }

  function renderDots() {
    el.beatDots.innerHTML = "";
    for (let i = 0; i < state.beatsPerBar; i++) {
      const dot = document.createElement("span");
      dot.className = "beat-dot" + (i === 0 ? " is-strong" : "");
      dot.setAttribute("aria-hidden", "true");
      if (i === 0) {
        // Accessible shape cue: strong beats get a square-ish via border-radius override
        dot.style.borderRadius = "6px";
        dot.title = "強拍";
      } else {
        dot.title = "弱拍";
      }
      el.beatDots.appendChild(dot);
    }
  }

  function setBpm(n, { fromSlider } = {}) {
    state.bpm = clampBpm(n);
    el.bpmValue.textContent = String(state.bpm);
    if (!fromSlider) el.bpmSlider.value = String(state.bpm);
  }

  function setMeter(beats, unit) {
    state.beatsPerBar = beats;
    state.beatUnit = unit;
    state.beatIndex = 0;
    el.meters.forEach((btn) => {
      const active =
        Number(btn.dataset.beats) === beats && Number(btn.dataset.unit) === unit;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    renderDots();
  }

  async function start() {
    ensureAudio();
    await state.audioCtx.resume();
    startSilentKeepAlive();
    await requestWakeLock();
    state.playing = true;
    state.beatIndex = 0;
    state.nextNoteTime = state.audioCtx.currentTime + 0.05;
    el.playStop.classList.add("is-playing");
    el.playStop.setAttribute("aria-pressed", "true");
    el.playStop.setAttribute("aria-label", "停止");
    el.playStopLabel.textContent = "停止 · Stop";
    scheduler();
  }

  function stop() {
    state.playing = false;
    if (state.timerId) {
      clearTimeout(state.timerId);
      state.timerId = null;
    }
    stopSilentKeepAlive();
    releaseWakeLock();
    el.playStop.classList.remove("is-playing");
    el.playStop.setAttribute("aria-pressed", "false");
    el.playStop.setAttribute("aria-label", "開始");
    el.playStopLabel.textContent = "開始 · Play";
    el.beatDots.querySelectorAll(".beat-dot").forEach((d) => d.classList.remove("is-active"));
  }

  function togglePlay() {
    ensureAudio();
    if (state.playing) stop();
    else start();
  }

  function onTap() {
    ensureAudio();
    const now = performance.now();
    // Reset if gap too long (> 2s)
    if (state.tapTimes.length && now - state.tapTimes[state.tapTimes.length - 1] > 2000) {
      state.tapTimes = [];
    }
    state.tapTimes.push(now);
    if (state.tapTimes.length > 6) state.tapTimes.shift();

    el.tap.classList.add("is-flash");
    setTimeout(() => el.tap.classList.remove("is-flash"), 100);

    if (state.tapTimes.length >= 2) {
      const intervals = [];
      for (let i = 1; i < state.tapTimes.length; i++) {
        intervals.push(state.tapTimes[i] - state.tapTimes[i - 1]);
      }
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      if (avg > 0) setBpm(60000 / avg);
    }
  }

  function bind() {
    el.bpmUp.addEventListener("click", () => {
      ensureAudio();
      setBpm(state.bpm + 1);
    });
    el.bpmDown.addEventListener("click", () => {
      ensureAudio();
      setBpm(state.bpm - 1);
    });
    el.bpmUp5.addEventListener("click", () => {
      ensureAudio();
      setBpm(state.bpm + 5);
    });
    el.bpmDown5.addEventListener("click", () => {
      ensureAudio();
      setBpm(state.bpm - 5);
    });
    el.bpmSlider.addEventListener("input", () => {
      ensureAudio();
      setBpm(Number(el.bpmSlider.value), { fromSlider: true });
    });
    el.tap.addEventListener("click", onTap);
    el.playStop.addEventListener("click", togglePlay);
    el.meters.forEach((btn) => {
      btn.addEventListener("click", () => {
        ensureAudio();
        setMeter(Number(btn.dataset.beats), Number(btn.dataset.unit));
      });
    });

    // Resume AudioContext on first gesture anywhere
    const unlock = () => {
      ensureAudio();
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && state.playing) {
        ensureAudio();
        requestWakeLock();
      }
    });
  }

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    // Only register when served over http(s); file:// will fail silently
    if (location.protocol === "file:") return;
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  setBpm(BPM_DEFAULT);
  setMeter(4, 4);
  bind();
  registerSW();
})();
