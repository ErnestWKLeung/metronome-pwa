(() => {
  "use strict";

  const BPM_MIN = 40;
  const BPM_MAX = 240;
  const BPM_DEFAULT = 120;

  const state = {
    bpm: BPM_DEFAULT,
    beatsPerBar: 4,
    beatUnit: 4, // denominator; 6/8 → eighth-note pulse
    subdivision: 0, // 0=off, 2=half, 3=triplet
    swing: false, // only meaningful when subdivision === 2
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
    subdivs: Array.from(document.querySelectorAll(".btn-subdiv")),
    swingToggle: document.getElementById("swing-toggle"),
    swingHint: document.getElementById("swing-hint"),
    installSection: document.getElementById("install-section"),
    installBtn: document.getElementById("install-btn"),
    installHowto: document.getElementById("install-howto"),
    installDone: document.getElementById("install-done"),
  };

  let deferredInstall = null;

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function setupInstallPrompt() {
    if (!el.installSection) return;

    if (isStandalone()) {
      el.installSection.classList.add("is-standalone");
      if (el.installDone) el.installDone.hidden = false;
      if (el.installHowto) el.installHowto.hidden = true;
      if (el.installBtn) el.installBtn.hidden = true;
      return;
    }

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredInstall = e;
      if (el.installBtn) el.installBtn.hidden = false;
    });

    window.addEventListener("appinstalled", () => {
      deferredInstall = null;
      if (el.installBtn) el.installBtn.hidden = true;
      el.installSection.classList.add("is-standalone");
      if (el.installDone) el.installDone.hidden = false;
      if (el.installHowto) el.installHowto.hidden = true;
    });

    if (el.installBtn) {
      el.installBtn.addEventListener("click", async () => {
        if (!deferredInstall) return;
        deferredInstall.prompt();
        try {
          await deferredInstall.userChoice;
        } catch (_) {
          /* ignore */
        }
        deferredInstall = null;
        el.installBtn.hidden = true;
      });
    }
  }

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
   * Synthesize a short click.
   * kind: "strong" | "weak" | "sub"
   * Subdivision clicks are quieter / softer than main beats.
   */
  function scheduleClick(time, kind) {
    const ctx = ensureAudio();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    let freq;
    let peak;
    let dur;
    let type = "square";

    if (kind === "strong") {
      freq = 1200;
      peak = 0.55;
      dur = 0.045;
    } else if (kind === "weak") {
      freq = 800;
      peak = 0.28;
      dur = 0.03;
    } else {
      // subdivision — lighter than weak main beat
      freq = 1600;
      peak = 0.1;
      dur = 0.018;
      type = "sine";
    }

    osc.type = type;
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

  function swingActive() {
    return state.subdivision === 2 && state.swing;
  }

  function scheduler() {
    if (!state.playing) return;
    const ctx = ensureAudio();
    while (state.nextNoteTime < ctx.currentTime + SCHEDULE_AHEAD) {
      const beatStart = state.nextNoteTime;
      const T = pulseSeconds();
      const isStrong = state.beatIndex === 0;

      // Main beat accent (strong/weak pattern preserved)
      scheduleClick(beatStart, isStrong ? "strong" : "weak");
      scheduleVisual(state.beatIndex, beatStart);

      // Subdivision clicks between main pulses (lighter)
      if (state.subdivision === 2) {
        const offset = swingActive() ? (2 / 3) * T : T / 2;
        scheduleClick(beatStart + offset, "sub");
      } else if (state.subdivision === 3) {
        scheduleClick(beatStart + T / 3, "sub");
        scheduleClick(beatStart + (2 * T) / 3, "sub");
      }

      state.nextNoteTime += T;
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

  function updateSwingUi() {
    const halfOn = state.subdivision === 2;
    if (el.swingToggle) {
      el.swingToggle.disabled = !halfOn;
      const on = halfOn && state.swing;
      el.swingToggle.classList.toggle("is-active", on);
      el.swingToggle.setAttribute("aria-pressed", on ? "true" : "false");
      el.swingToggle.textContent = on ? "Swing · 開啟" : "Swing · 關閉";
    }
    if (el.swingHint) {
      el.swingHint.textContent = halfOn
        ? "Swing 固定 2:1（長∶短）"
        : "Swing 只喺「半拍」時可用（固定 2:1）";
    }
  }

  function setSubdivision(n) {
    const next = n === 2 || n === 3 ? n : 0;
    state.subdivision = next;
    if (next !== 2) {
      // Spec: when not half-beat, treat swing as off (control disabled)
      state.swing = false;
    }
    el.subdivs.forEach((btn) => {
      const active = Number(btn.dataset.subdiv) === next;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-pressed", active ? "true" : "false");
    });
    updateSwingUi();
  }

  function setSwing(on) {
    if (state.subdivision !== 2) {
      state.swing = false;
    } else {
      state.swing = !!on;
    }
    updateSwingUi();
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
    el.subdivs.forEach((btn) => {
      btn.addEventListener("click", () => {
        ensureAudio();
        setSubdivision(Number(btn.dataset.subdiv));
      });
    });
    if (el.swingToggle) {
      el.swingToggle.addEventListener("click", () => {
        if (state.subdivision !== 2) return;
        ensureAudio();
        setSwing(!state.swing);
      });
    }

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
  setSubdivision(0);
  bind();
  setupInstallPrompt();
  registerSW();
})();
