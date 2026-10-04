/* Native media avoids starving Godot's single-threaded Web audio mixer. */
(() => {
  const sources = { music: 'school-song.mp3', birds: 'birds.mp3', wind: 'wind.mp3', bell: 'bell-preview.mp3' };
  const tracks = new Set();
  const retry = document.createElement('button');
  retry.textContent = '點此開啟聲音';
  retry.hidden = true;
  retry.style.cssText = 'position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:10';
  document.body.appendChild(retry);
  function retryBlocked() { for (const track of tracks) track.sync(); }
  retry.addEventListener('click', retryBlocked);
  document.addEventListener('pointerdown', retryBlocked);
  document.addEventListener('keydown', retryBlocked);
  document.addEventListener('visibilitychange', retryBlocked);
  window.CampusAudio = {
    create(key) {
      if (!sources[key]) throw new Error('Unknown campus audio channel');
      const element = new Audio(new URL('audio/' + sources[key], document.baseURI).href);
      element.preload = 'auto';
      element.loop = key !== 'bell';
      element.volume = 0;
      element.dataset.campusAudio = key;
      element.hidden = true;
      document.body.appendChild(element);
      let wanted = false, paused = false, pending = false, disposed = false;
      const track = {
        sync() {
          if (disposed) return;
          if (!wanted || paused || document.hidden) { element.pause(); return; }
          if (!element.paused || pending) return;
          pending = true;
          let retryAfter = false;
          element.play().then(() => {
            retryAfter = true;
            retry.hidden = true;
            if (!wanted || paused || document.hidden || disposed) element.pause();
          }).catch(error => {
            retryAfter = error.name === 'AbortError';
            if (error.name === 'NotAllowedError') retry.hidden = false;
            else if (error.name !== 'AbortError') console.warn('Campus audio:', key, error.name);
          }).finally(() => {
            pending = false;
            if (retryAfter && wanted && !paused && !document.hidden && element.paused) track.sync();
          });
        },
        play() { wanted = true; if (key === 'bell') element.currentTime = 0; track.sync(); },
        stop() { wanted = false; element.pause(); element.currentTime = 0; },
        setPaused(value) { paused = value; track.sync(); },
        setVolume(value) { element.volume = Math.min(1, Math.max(0, value)); },
        isPlaying() { return wanted && !element.ended; },
        dispose() { track.stop(); disposed = true; tracks.delete(track); element.removeAttribute('src'); element.load(); element.remove(); }
      };
      element.addEventListener('ended', () => { if (!element.loop) wanted = false; });
      tracks.add(track);
      return track;
    }
  };
})();
