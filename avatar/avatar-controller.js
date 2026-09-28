const CONFIG = Object.freeze({
  introDelayMs: 480,
  introDurationMs: 2400,
  maxDpr: 1.5,
  cacheSize: 80,
  windPeakProgress: .78,
  frameRoot: 'avatar/frames',
  windVideo: 'avatar/raining%20wind.mp4',
  backdropKey: Object.freeze({
    sampleInset: 3,
    sampleStep: 4,
    sampleMin: 205,
    sampleChroma: 28,
    floodMin: 108,
    floodChroma: 42,
    floodDistance: 124,
    transparentDistance: 5,
    opaqueDistance: 82,
  }),
  colorGain: Object.freeze([1.013, 1.01, 1.015]),
});

const SEQUENCES = Object.freeze({ vertical: 71, wind: 30 });
const NEUTRAL_FRAME = SEQUENCES.vertical - 1;
const RESTING_EXPRESSION_FRAME = 'wind:0';
const stage = document.querySelector('[data-avatar-stage]');

if (stage) {
  const canvas = stage.querySelector('canvas');
  const fallback = stage.querySelector('.avatar-fallback');
  const context = canvas.getContext('2d', { alpha: true, desynchronized: true });
  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  const hero = document.querySelector('.hero');
  const cache = new Map();
  const failed = new Set();
  const windVideo = document.createElement('video');
  windVideo.preload = 'auto';
  windVideo.muted = true;
  windVideo.playsInline = true;
  windVideo.disablePictureInPicture = true;
  windVideo.src = CONFIG.windVideo;
  let windVideoReady = false;
  let windVideoFailed = false;
  let windBlobFallbackStarted = false;
  let windObjectUrl = '';
  let windRaf = 0;
  let requestedWindTime = -1;
  let canvasSizeDirty = true;
  let matteMask = new Uint8Array(0);
  let matteQueue = new Int32Array(0);
  let matteHistogram = [new Uint16Array(256), new Uint16Array(256), new Uint16Array(256)];
  const state = {
    phase: motionQuery.matches ? 'complete' : 'intro',
    progress: 0,
    startedAt: null,
    // null means neutral; a number is eased progress supplied by the master hero timeline.
    visualProgress: Number.isFinite(window.avatarVisualProgress) ? window.avatarVisualProgress : null,
    raf: 0,
    visible: true,
  };
  let lastDrawnKey = '';
  let verticalFramesReady = false;
  let windAssetReady = false;
  let avatarAssetsEventSent = false;

  function dispatchAvatarAssetsReady() {
    if (!verticalFramesReady || !windAssetReady || avatarAssetsEventSent) return;
    avatarAssetsEventSent = true;
    window.dispatchEvent(new Event('avatarassetsready'));
  }

  function preloadVerticalFrames() {
    const frames = Array.from({ length: SEQUENCES.vertical }, (_, index) => getFrame(frameKey('vertical', index)));
    frames.push(getFrame(RESTING_EXPRESSION_FRAME));
    return Promise.all(frames);
  }

  function frameKey(sequence, index) {
    const bounded = Math.max(0, Math.min(SEQUENCES[sequence] - 1, Math.round(index)));
    return `${sequence}:${bounded}`;
  }

  function frameUrl(key) {
    const [sequence, index] = key.split(':');
    return `${CONFIG.frameRoot}/${sequence}/f${String(index).padStart(4, '0')}.webp`;
  }

  function currentFrameKey() {
    const frame = state.phase === 'intro' ? state.progress * NEUTRAL_FRAME : NEUTRAL_FRAME;
    return frameKey('vertical', frame);
  }

  function getFrame(key) {
    if (failed.has(key)) return Promise.resolve(null);
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key);
      cache.set(key, entry);
      return entry.promise;
    }

    const image = new Image();
    entry = { image, promise: new Promise(resolve => {
      image.onload = () => {
        const decoded = image.decode ? image.decode().catch(() => {}) : Promise.resolve();
        decoded.then(() => resolve(image));
      };
      image.onerror = () => {
        failed.add(key);
        resolve(null);
      };
    }) };
    cache.set(key, entry);
    image.src = frameUrl(key);
    if (image.decode) image.decode().catch(() => {});
    while (cache.size > CONFIG.cacheSize) {
      const oldestUnpinned = [...cache.keys()].find(candidate => candidate !== `vertical:${NEUTRAL_FRAME}` && candidate !== RESTING_EXPRESSION_FRAME);
      if (!oldestUnpinned) break;
      cache.delete(oldestUnpinned);
    }
    entry.promise.then(() => {
      if (state.visible) {
        if (key === currentFrameKey()) lastDrawnKey = '';
        schedule();
      }
    });
    return entry.promise;
  }

  function peekFrame(key) {
    const image = cache.get(key)?.image;
    return image?.complete && image.naturalWidth ? image : null;
  }

  function setCanvasScale() {
    if (!canvasSizeDirty) return;
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
    const bounds = canvas.getBoundingClientRect();
    const width = Math.min(640, Math.max(1, Math.round(bounds.width * dpr)));
    const height = Math.min(720, Math.max(1, Math.round(bounds.height * dpr)));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    canvasSizeDirty = false;
  }

  function drawImage(image) {
    setCanvasScale();
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    stage.classList.add('is-ready');
    return true;
  }

  function drawRestingFrame() {
    const neutral = peekFrame(frameKey('vertical', NEUTRAL_FRAME));
    if (!neutral) return drawFrame(frameKey('vertical', NEUTRAL_FRAME));

    drawImage(neutral);
    const expression = peekFrame(RESTING_EXPRESSION_FRAME);
    if (!expression) {
      getFrame(RESTING_EXPRESSION_FRAME).then(image => {
        if (image && state.phase === 'complete' && state.visualProgress === null && state.visible) drawRestingFrame();
      });
      return true;
    }

    context.save();
    context.setTransform(canvas.width / 640, 0, 0, canvas.height / 720, 0, 0);
    context.beginPath();
    context.ellipse(320, 425, 47, 17, 0, 0, Math.PI * 2);
    context.clip();
    context.drawImage(expression, 0, 0, 640, 720);
    context.restore();
    return true;
  }

  function drawFrame(key) {
    const image = peekFrame(key);
    if (image) return drawImage(image);
    if (failed.has(key)) {
      const neutral = peekFrame(frameKey('vertical', NEUTRAL_FRAME));
      if (neutral) return drawImage(neutral);
      return false;
    }
    getFrame(key);
    return false;
  }

  function getBackdropColor(pixels, width, height) {
    const config = CONFIG.backdropKey;
    for (const channel of matteHistogram) channel.fill(0);
    let count = 0;
    const sample = (x, y) => {
      const offset = (y * width + x) * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      if (Math.min(red, green, blue) < config.sampleMin || Math.max(red, green, blue) - Math.min(red, green, blue) > config.sampleChroma) return;
      matteHistogram[0][red]++;
      matteHistogram[1][green]++;
      matteHistogram[2][blue]++;
      count++;
    };

    for (let x = config.sampleInset; x < width - config.sampleInset; x += config.sampleStep) {
      sample(x, config.sampleInset);
      sample(x, config.sampleInset + config.sampleStep);
    }
    for (let y = config.sampleInset; y < height - config.sampleInset; y += config.sampleStep) {
      sample(config.sampleInset, y);
      sample(width - config.sampleInset - 1, y);
    }
    if (!count) return [240, 240, 240];

    return matteHistogram.map(histogram => {
      const midpoint = Math.floor(count / 2);
      let accumulated = 0;
      for (let value = 0; value < histogram.length; value++) {
        accumulated += histogram[value];
        if (accumulated > midpoint) return value;
      }
      return 240;
    });
  }

  function removeVideoBackdrop(imageData) {
    const { width, height, data: pixels } = imageData;
    const config = CONFIG.backdropKey;
    const pixelCount = width * height;
    const backdrop = getBackdropColor(pixels, width, height);
    const rowBackdrops = new Uint8Array(height * 3);
    const isBackdropSample = (red, green, blue) => Math.min(red, green, blue) >= 150 && Math.max(red, green, blue) - Math.min(red, green, blue) <= 75;
    for (let y = 0; y < height; y++) {
      const left = y * width * 4;
      const right = (y * width + width - 1) * 4;
      const leftIsBackdrop = isBackdropSample(pixels[left], pixels[left + 1], pixels[left + 2]);
      const rightIsBackdrop = isBackdropSample(pixels[right], pixels[right + 1], pixels[right + 2]);
      for (let channel = 0; channel < 3; channel++) {
        const leftValue = pixels[left + channel];
        const rightValue = pixels[right + channel];
        rowBackdrops[y * 3 + channel] = leftIsBackdrop && rightIsBackdrop
          ? Math.round((leftValue + rightValue) / 2)
          : leftIsBackdrop ? leftValue : rightIsBackdrop ? rightValue : backdrop[channel];
      }
    }
    if (matteMask.length !== pixelCount) {
      matteMask = new Uint8Array(pixelCount);
      matteQueue = new Int32Array(pixelCount);
    }
    matteMask.fill(0);
    let head = 0;
    let tail = 0;

    const enqueue = (x, y) => {
      const index = y * width + x;
      if (matteMask[index]) return;
      matteMask[index] = 1;
      const offset = index * 4;
      const red = pixels[offset];
      const green = pixels[offset + 1];
      const blue = pixels[offset + 2];
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const rowOffset = y * 3;
      const distance = Math.max(Math.abs(red - rowBackdrops[rowOffset]), Math.abs(green - rowBackdrops[rowOffset + 1]), Math.abs(blue - rowBackdrops[rowOffset + 2]));
      if (Math.min(red, green, blue) < config.floodMin || chroma > config.floodChroma || distance > config.floodDistance) return;
      matteMask[index] = 2;
      matteQueue[tail++] = index;
    };

    for (let x = 0; x < width; x++) enqueue(x, 0);
    for (let y = 1; y < height - 1; y++) {
      enqueue(0, y);
      enqueue(width - 1, y);
    }
    for (let x = 0; x < width; x++) enqueue(x, height - 1);

    while (head < tail) {
      const index = matteQueue[head++];
      const x = index % width;
      const y = (index / width) | 0;
      if (x > 0) enqueue(x - 1, y);
      if (x + 1 < width) enqueue(x + 1, y);
      if (y > 0) enqueue(x, y - 1);
      if (y + 1 < height) enqueue(x, y + 1);
    }

    const featherRange = config.opaqueDistance - config.transparentDistance;
    for (let y = 0; y < height; y++) {
      const rowOffset = y * 3;
      const rowStart = y * width;
      for (let x = 0; x < width; x++) {
        const index = rowStart + x;
        const offset = index * 4;
        const red = pixels[offset];
        const green = pixels[offset + 1];
        const blue = pixels[offset + 2];
        let alpha = pixels[offset + 3] / 255;

        if (matteMask[index] === 2) {
          const distance = Math.max(Math.abs(red - rowBackdrops[rowOffset]), Math.abs(green - rowBackdrops[rowOffset + 1]), Math.abs(blue - rowBackdrops[rowOffset + 2]));
          const amount = Math.max(0, Math.min(1, (distance - config.transparentDistance) / featherRange));
          const matte = amount * amount * (3 - 2 * amount);
          alpha *= matte;
          if (alpha > .015 && matte < 1) {
            pixels[offset] = Math.max(0, Math.min(255, (red - rowBackdrops[rowOffset] * (1 - matte)) / matte));
            pixels[offset + 1] = Math.max(0, Math.min(255, (green - rowBackdrops[rowOffset + 1] * (1 - matte)) / matte));
            pixels[offset + 2] = Math.max(0, Math.min(255, (blue - rowBackdrops[rowOffset + 2] * (1 - matte)) / matte));
          }
        }

        pixels[offset] = Math.min(255, pixels[offset] * CONFIG.colorGain[0]);
        pixels[offset + 1] = Math.min(255, pixels[offset + 1] * CONFIG.colorGain[1]);
        pixels[offset + 2] = Math.min(255, pixels[offset + 2] * CONFIG.colorGain[2]);
        pixels[offset + 3] = Math.round(alpha * 255);
      }
    }

    return backdrop;
  }

  function drawWindVideo() {
    if (!windVideoReady || windVideoFailed || windVideo.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false;
    setCanvasScale();
    try {
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(windVideo, 320, 0, 640, 720, 0, 0, canvas.width, canvas.height);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      removeVideoBackdrop(imageData);
      context.putImageData(imageData, 0, 0);
      stage.classList.add('is-ready');
      return true;
    } catch {
      return false;
    }
  }

  function failWindVideo() {
    windVideoFailed = true;
    windVideoReady = false;
    windAssetReady = true;
    dispatchAvatarAssetsReady();
    if (state.visible && state.phase !== 'intro') drawRestingFrame();
  }

  function loadSeekableWindBlob() {
    if (windBlobFallbackStarted) return;
    windBlobFallbackStarted = true;
    windVideoReady = false;
    windVideo.pause();
    fetch(CONFIG.windVideo, { cache: 'force-cache' })
      .then(response => {
        if (!response.ok) throw new Error(`Wind video request failed: ${response.status}`);
        return response.blob();
      })
      .then(blob => {
        windObjectUrl = URL.createObjectURL(blob);
        windVideo.src = windObjectUrl;
        windVideo.load();
      })
      .catch(failWindVideo);
  }

  function onWindVideoLoaded() {
    // Buffer the complete file once so timeline seeks do not depend on a
    // device's range-request behavior or network jitter.
    if (!windBlobFallbackStarted) {
      loadSeekableWindBlob();
      return;
    }
    windVideoReady = true;
    windVideoFailed = false;
    windAssetReady = true;
    dispatchAvatarAssetsReady();
    windVideo.pause();
    scheduleWindSeek();
  }

  function scheduleWindSeek() {
    if (!state.visible || state.phase === 'intro' || state.visualProgress === null || !windVideoReady || windVideoFailed || windRaf) return;
    windRaf = requestAnimationFrame(() => {
      windRaf = 0;
      if (!state.visible || state.phase === 'intro' || state.visualProgress === null || !windVideoReady) return;
      const duration = Number.isFinite(windVideo.duration) ? windVideo.duration : 0;
      if (!duration) return;
      const nextTime = Math.max(0, Math.min(duration, state.visualProgress * duration * CONFIG.windPeakProgress));
      if (Math.abs(requestedWindTime - nextTime) > 1 / 240) {
        requestedWindTime = nextTime;
        // The master timeline's eased visual state is the seek target; the media never plays itself.
        windVideo.currentTime = nextTime;
      }
    });
  }

  function schedule() {
    if (state.phase === 'intro' && !state.raf) state.raf = requestAnimationFrame(tick);
  }

  function tick(now) {
    state.raf = 0;
    if (state.phase !== 'intro') {
      scheduleWindSeek();
      return;
    }
    if (!verticalFramesReady) {
      schedule();
      return;
    }

    if (state.startedAt === null) {
      if (!peekFrame(frameKey('vertical', 0))) {
        getFrame(frameKey('vertical', 0));
        schedule();
        return;
      }
      state.startedAt = now + CONFIG.introDelayMs;
    }

    state.progress = Math.max(0, Math.min(1, (now - state.startedAt) / CONFIG.introDurationMs));
    const frame = Math.round(state.progress * NEUTRAL_FRAME);
    const key = frameKey('vertical', frame);
    if (key !== lastDrawnKey && drawFrame(key)) {
      lastDrawnKey = key;
      if (frame < NEUTRAL_FRAME) getFrame(frameKey('vertical', frame + 1));
    }
    if (state.progress < 1) schedule();
    else {
      state.phase = 'complete';
      drawRestingFrame();
      window.dispatchEvent(new Event('avatarintrocomplete'));
      // If the user scrolled during the intro, begin showing the timeline's current frame only after the intro is done.
      if (state.visualProgress !== null) scheduleWindSeek();
    }
  }

  window.addEventListener('avatarvisualprogress', event => {
    const detail = event.detail;
    state.visualProgress = detail === null ? null : Math.max(0, Math.min(1, Number(detail) || 0));
    window.avatarVisualProgress = state.visualProgress;
    if (state.phase !== 'intro') {
      lastDrawnKey = '';
      if (state.visualProgress === null) {
        drawRestingFrame();
        lastDrawnKey = frameKey('vertical', NEUTRAL_FRAME);
      } else scheduleWindSeek();
    }
  });

  window.addEventListener('resize', () => {
    canvasSizeDirty = true;
    lastDrawnKey = '';
    if (state.phase === 'complete' && state.visualProgress === null) drawRestingFrame();
    else if (state.phase === 'complete') {
      requestedWindTime = -1;
      scheduleWindSeek();
    } else schedule();
  }, { passive: true });

  if ('IntersectionObserver' in window && hero) {
    const observer = new IntersectionObserver(entries => {
      state.visible = entries[0].isIntersecting;
      if (state.visible) {
        requestedWindTime = -1;
        schedule();
        scheduleWindSeek();
      }
      if (!state.visible && windRaf) {
        cancelAnimationFrame(windRaf);
        windRaf = 0;
      }
    }, { threshold: 0 });
    observer.observe(hero);
  }

  motionQuery.addEventListener('change', event => {
    if (event.matches) {
      state.visualProgress = null;
      state.phase = 'complete';
      state.progress = 1;
      if (state.raf) cancelAnimationFrame(state.raf);
      state.raf = 0;
      lastDrawnKey = '';
      getFrame(frameKey('vertical', NEUTRAL_FRAME)).then(() => {
        if (state.visible) {
          drawRestingFrame();
          lastDrawnKey = frameKey('vertical', NEUTRAL_FRAME);
        }
      });
      if (windRaf) cancelAnimationFrame(windRaf);
      windRaf = 0;
      windVideo.pause();
    }
  });

  windVideo.addEventListener('loadeddata', onWindVideoLoaded);
  windVideo.addEventListener('seeked', () => {
    if (state.visualProgress === null || state.phase === 'intro' || !state.visible) return;
    const target = windVideo.duration * state.visualProgress * CONFIG.windPeakProgress;
    if (Math.abs(windVideo.currentTime - target) > 1 / 48) {
      requestedWindTime = -1;
      scheduleWindSeek();
    }
    else drawWindVideo();
  });
  windVideo.addEventListener('error', () => {
    if (windBlobFallbackStarted) failWindVideo();
    else loadSeekableWindBlob();
  });
  window.addEventListener('pagehide', () => {
    if (windObjectUrl) URL.revokeObjectURL(windObjectUrl);
  }, { once: true });
  windVideo.load();

  preloadVerticalFrames().then(() => {
    verticalFramesReady = true;
    dispatchAvatarAssetsReady();
    schedule();
  });

  fallback.addEventListener('load', schedule, { once: true });
  if (fallback.complete) schedule();
  if (motionQuery.matches) {
    getFrame(frameKey('vertical', NEUTRAL_FRAME)).then(image => {
      if (image) {
        drawRestingFrame();
        lastDrawnKey = frameKey('vertical', NEUTRAL_FRAME);
      }
    });
  }
}
