/* Native media avoids starving Godot's single-threaded Web audio mixer.
   iPad／iPhone Safari ignores element.volume (always full), so a channel turned down to nothing is paused instead: the birds
   in the rain or at night, the frogs on a dry day, muting (老師 2026-11-28「下雨時竟然還會聽到鳥叫聲」).
   音量真的調得動 (2026-11-28, 老師「教室裡雨聲還是太大」「雨聲重播時有很高頻的尖刺雜音」):
   - Where the browser has Web Audio, each element plays through its own gain node (the volume Godot asks for), which iPad
     Safari does honour. Element volume stays the fallback.
   - The ambient loops (birds, wind, rain, insects, frogs) no longer use element.loop: an MP3 carries a few extra milliseconds
     at its end and a looping element played them before jumping back, a click at every restart. Two copies take turns
     instead: OVERLAP seconds before one ends the other starts from the beginning and they cross-fade (equal power). */
(() => {
  const sources = {
    music: 'school-song.mp3', birds: 'birds.mp3', wind: 'wind.mp3', bell: 'bell-preview.mp3', insects: 'insects.mp3', frogs: 'frogs.mp3',
    rain_light: 'rain-light.mp3', rain_mid: 'rain-mid.mp3', rain_heavy: 'rain-heavy.mp3'
  };
  const LOOPED = new Set(['birds', 'wind', 'insects', 'frogs', 'rain_light', 'rain_mid', 'rain_heavy']);
  const OVERLAP = 2.0; // seconds of cross-fade where a loop starts again
  const SPARE = 0.5; // the fade ends this long before the old copy's end
  const CURVE = 24;
  const tracks = new Set();
  let ac = null; // the Web Audio context, made on first use; false when the browser has none
  function audioContext() {
    if (ac === null) {
      try { const AC = window.AudioContext || window.webkitAudioContext; ac = AC ? new AC() : false; } catch (error) { ac = false; }
    }
    return ac || null;
  }
  const retry = document.createElement('button');
  retry.textContent = '點此開啟聲音';
  retry.hidden = true;
  retry.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:10';
  document.body.appendChild(retry);
  function retryBlocked(event) {
    // The context is made inside the first tap or key press (the 開始校園冒險 click, before the game asks for any sound), so it
    // starts running; a suspended one (iOS after a call) resumes only inside a tap or key press too.
    const context = event && event.type !== 'visibilitychange' ? audioContext() : ac;
    if (context && context.state !== 'running' && context.resume) context.resume().catch(() => {});
    for (const track of tracks) track.sync();
  }
  retry.addEventListener('click', retryBlocked);
  document.addEventListener('pointerdown', retryBlocked);
  document.addEventListener('keydown', retryBlocked);
  document.addEventListener('visibilitychange', retryBlocked);
  setInterval(() => { for (const track of tracks) track.tick(); }, 100);
  const fadeCurve = up => Float32Array.from({ length: CURVE }, (_, i) => { const t = i / (CURVE - 1) * Math.PI / 2; return up ? Math.sin(t) : Math.cos(t); });

  window.CampusAudio = {
    create(key) {
      if (!sources[key]) throw new Error('Unknown campus audio channel');
      const looped = LOOPED.has(key);
      const context = audioContext();
      let trackGain = null;
      if (context) {
        try { trackGain = context.createGain(); trackGain.gain.value = 0; trackGain.connect(context.destination); } catch (error) { trackGain = null; }
      }
      let wanted = false, paused = false, disposed = false, quiet = true, volume = 0;
      const copy = () => {
        const element = new Audio(new URL('audio/' + sources[key], document.baseURI).href);
        element.preload = window.campusLite ? 'none' : 'auto'; // 省資源模式 (web/shell.html): loads when first played
        element.loop = !looped && key !== 'bell';
        element.volume = 0;
        element.dataset.campusAudio = key;
        element.hidden = true;
        document.body.appendChild(element);
        const c = { element, gain: null, share: 1, pending: false, on: false };
        if (trackGain) {
          try {
            const source = context.createMediaElementSource(element);
            c.gain = context.createGain(); c.gain.gain.value = 1;
            source.connect(c.gain); c.gain.connect(trackGain);
            element.volume = 1; // the gain nodes set the level now
          } catch (error) { c.gain = null; }
        }
        return c;
      };
      const copies = looped ? [copy(), copy()] : [copy()];
      let current = 0, fading = null; // fading: {from, to, until} while two copies overlap
      const level = c => {
        if (c.gain) return;
        c.element.volume = Math.min(1, Math.max(0, volume * c.share));
      };
      const playCopy = c => {
        if (!c.element.paused || c.pending) return;
        c.pending = true;
        let retryAfter = false;
        c.element.play().then(() => {
          retryAfter = true;
          retry.hidden = true;
          if (!c.on || !wanted || paused || quiet || document.hidden || disposed) c.element.pause();
        }).catch(error => {
          retryAfter = error.name === 'AbortError';
          if (error.name === 'NotAllowedError') retry.hidden = false;
          else if (error.name !== 'AbortError') console.warn('Campus audio:', key, error.name);
        }).finally(() => {
          c.pending = false;
          if (retryAfter && c.on && wanted && !paused && !quiet && !document.hidden && c.element.paused) playCopy(c);
        });
      };
      // The overlap is over (or cannot go on while paused): the new copy alone, at full share.
      const finishFade = () => {
        if (!fading) return;
        const { from, to } = fading;
        fading = null;
        from.on = false; from.element.pause(); from.element.currentTime = 0;
        to.share = 1; from.share = 1;
        if (to.gain) { to.gain.gain.cancelScheduledValues(0); to.gain.gain.value = 1; }
        if (from.gain) { from.gain.gain.cancelScheduledValues(0); from.gain.gain.value = 1; }
        level(to); level(from);
        current = copies.indexOf(to);
      };
      const startFade = () => {
        const from = copies[current], to = copies[1 - current];
        if (fading || !to) return;
        to.element.currentTime = 0;
        to.on = true;
        fading = { from, to, until: performance.now() + OVERLAP * 1000, began: performance.now() };
        if (to.gain && from.gain) {
          const now = context.currentTime;
          to.gain.gain.cancelScheduledValues(now); from.gain.gain.cancelScheduledValues(now);
          to.gain.gain.setValueCurveAtTime(fadeCurve(true), now, OVERLAP);
          from.gain.gain.setValueCurveAtTime(fadeCurve(false), now, OVERLAP);
        } else { to.share = 0; level(to); }
        playCopy(to);
      };
      const track = {
        sync() {
          if (disposed) return;
          const run = wanted && !paused && !quiet && !document.hidden;
          if (!run) {
            if (fading) finishFade();
            for (const c of copies) c.element.pause();
            return;
          }
          copies[current].on = true;
          for (const c of copies) if (c.on) playCopy(c);
        },
        // Every 100 ms: start the cross-fade near the end of a loop, step it where there are no gain nodes, end it.
        tick() {
          if (disposed || !looped || !wanted || paused || quiet || document.hidden) return;
          const now = performance.now();
          if (fading) {
            if (now >= fading.until) { finishFade(); return; }
            if (!fading.to.gain) {
              const t = Math.min(1, (now - fading.began) / (OVERLAP * 1000)) * Math.PI / 2;
              fading.to.share = Math.sin(t); fading.from.share = Math.cos(t);
              level(fading.to); level(fading.from);
            }
            return;
          }
          const e = copies[current].element;
          // Half a second to spare: the fade is over before the MP3's last few milliseconds (where the click was) are reached.
          if (Number.isFinite(e.duration) && e.duration > OVERLAP * 2 && !e.paused && e.currentTime >= e.duration - OVERLAP - SPARE) startFade();
        },
        play() { wanted = true; if (key === 'bell') copies[0].element.currentTime = 0; track.sync(); },
        stop() {
          wanted = false;
          if (fading) finishFade();
          for (const c of copies) { c.element.pause(); c.element.currentTime = 0; }
        },
        setPaused(value) { paused = value; track.sync(); },
        setVolume(value) {
          volume = Math.min(1, Math.max(0, value));
          if (trackGain) trackGain.gain.value = volume;
          for (const c of copies) level(c);
          const silent = !(value > 0.001);
          if (silent !== quiet) { quiet = silent; track.sync(); }
        },
        isPlaying() { return wanted && !copies[current].element.ended; },
        getTime() { return copies[current].element.currentTime || 0; },
        getDuration() { const d = copies[current].element.duration; return Number.isFinite(d) ? d : 0; },
        dispose() {
          track.stop(); disposed = true; tracks.delete(track);
          for (const c of copies) { c.element.removeAttribute('src'); c.element.load(); c.element.remove(); }
          if (trackGain) try { trackGain.disconnect(); } catch (error) {}
        }
      };
      copies.forEach(c => c.element.addEventListener('ended', () => {
        if (key === 'bell') { wanted = false; return; }
        // A loop's copy ran out before the cross-fade could start (a slow background tab): the other one starts at once.
        if (looped && c === copies[current] && !fading) {
          c.on = false;
          const next = copies[1 - current];
          next.element.currentTime = 0; next.on = true; next.share = 1; level(next);
          current = 1 - current;
          track.sync();
        }
      }));
      tracks.add(track);
      return track;
    }
  };
})();
