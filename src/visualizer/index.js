import { Random, mapValue } from '../utils/random.js';

export function createVisualizer({ canvasId = 'visualizerCanvas', isAudioReady = () => true } = {}) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    throw new Error(`Canvas with id "${canvasId}" not found`);
  }
  const canvasCtx = canvas.getContext('2d');
  const GRID_SIZE = 25;
  const BORING_WORD = 'BORING';
  const BORING_FONT = {
    B: ['11110', '10001', '11110', '10001', '10001', '11110', '00000'],
    O: ['01110', '10001', '10001', '10001', '10001', '01110', '00000'],
    R: ['11110', '10001', '11110', '10010', '10010', '10010', '00000'],
    I: ['11111', '00100', '00100', '00100', '00100', '11111', '00000'],
    N: ['10001', '11001', '10101', '10011', '10001', '10001', '00000'],
    G: ['01110', '10001', '10000', '10011', '10001', '01110', '00000'],
  };
  const BORING_LETTER_WIDTH = 5;
  const BORING_LETTER_HEIGHT = 7;
  const BORING_LETTER_SPACING = 2;
  const SIMPLE_START_COLORS = [
    { hue: 0, saturation: 80, lightness: 55 },
    { hue: 55, saturation: 90, lightness: 60 },
    { hue: 225, saturation: 80, lightness: 50 },
    { hue: 120, saturation: 65, lightness: 50 },
    { hue: 0, saturation: 0, lightness: 6 },
    { hue: 0, saturation: 0, lightness: 95 },
  ];

  let visualizerAnimationId = null;
  let visualizerRunning = true;
  let grid = [];
  let cols = 0;
  let rows = 0;
  let currentBaseHue = 0;
  let simpleColorIndex = 0;
  let boringSequencePromise = null;
  let audioReadyChecker = typeof isAudioReady === 'function' ? isAudioReady : () => true;

  function setupGrid() {
    cols = Math.ceil(canvas.width / GRID_SIZE);
    rows = Math.ceil(canvas.height / GRID_SIZE);
    grid = [];
    for (let i = 0; i < cols; i++) {
      grid[i] = [];
      for (let j = 0; j < rows; j++) {
        grid[i][j] = { life: 0, hue: 0, saturation: 0, lightness: 0, fadeSpeed: 0.01 };
      }
    }
  }

  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    setupGrid();
  }

  function resetSimpleStartColors() {
    simpleColorIndex = 0;
  }

  function useSimpleStartColor() {
    if (simpleColorIndex >= SIMPLE_START_COLORS.length) {
      return null;
    }
    const color = SIMPLE_START_COLORS[simpleColorIndex];
    simpleColorIndex += 1;
    return color;
  }

  function drawBoringLetter(letter, baseX, baseY, hueShift = 0) {
    const pattern = BORING_FONT[letter];
    if (!pattern) return;
    for (let rowIdx = 0; rowIdx < pattern.length; rowIdx++) {
      const row = pattern[rowIdx];
      for (let colIdx = 0; colIdx < row.length; colIdx++) {
        if (row[colIdx] !== '1') continue;
        const x = baseX + colIdx;
        const y = baseY + rowIdx;
        const cell = grid[x] && grid[x][y];
        if (!cell) continue;
        cell.life = 1;
        cell.hue = (currentBaseHue + hueShift) % 360;
        cell.saturation = 70;
        cell.lightness = 72;
        cell.fadeSpeed = 0.015;
      }
    }
  }

  function playBoringSequence() {
    if (!cols || !rows) return Promise.resolve();
    if (boringSequencePromise) return boringSequencePromise;
    const word = BORING_WORD;
    const totalWidth = word.length * BORING_LETTER_WIDTH + (word.length - 1) * BORING_LETTER_SPACING;
    const startX = Math.max(0, Math.floor((cols - totalWidth) / 2));
    const startY = Math.max(0, Math.floor((rows - BORING_LETTER_HEIGHT) / 2));
    const letterDelay = 90;
    boringSequencePromise = new Promise((resolve) => {
      word.split('').forEach((letter, idx) => {
        const offsetX = startX + idx * (BORING_LETTER_WIDTH + BORING_LETTER_SPACING);
        setTimeout(() => {
          drawBoringLetter(letter, offsetX, startY, idx * 12);
        }, idx * letterDelay);
      });
      setTimeout(() => {
        boringSequencePromise = null;
        resolve();
      }, letterDelay * (word.length + 3));
    });
    return boringSequencePromise;
  }

  function triggerDrumVisual(drumType, intensity) {
    if (intensity <= 0 || !audioReadyChecker()) return;

    const hue = currentBaseHue;

    switch (drumType) {
      case 'kick': {
        const radiusLimit = Math.floor(mapValue(intensity, 0, 1, 1, 3));
        const columns = [Math.floor(cols * 0.25), Math.floor(cols * 0.5), Math.floor(cols * 0.75)];
        const centerX = columns[Random.int(0, columns.length - 1)];
        const centerY = Math.floor(rows * 0.8);
        const circleHue = (hue + 180 + Random.float(-5, 5)) % 360;
        for (let r = 0; r <= radiusLimit; r++) {
          const decay = 1 - r / (radiusLimit + 1);
          const lifeIncrease = mapValue(decay, 0, 1, 0.1, 0.5) * intensity;
          for (let dx = -r; dx <= r; dx++) {
            for (let dy = -r; dy <= r; dy++) {
              if (Math.abs(dx) + Math.abs(dy) > r) continue;
              const x = centerX + dx;
              const y = centerY + dy;
              if (x < 0 || x >= cols || y < 0 || y >= rows) continue;
              const cell = grid[x][y];
              if (!cell) continue;
              cell.life = Math.min(0.6, cell.life + lifeIncrease);
              cell.hue = circleHue;
              cell.saturation = 55;
              cell.lightness = 68;
              cell.fadeSpeed = 0.005 + (1 - decay) * 0.005;
            }
          }
        }
        break;
      }
      case 'snare': {
        const snareLength = Math.floor(mapValue(intensity, 0, 1, 3, 8));
        for (let i = 0; i < 4; i++) {
          const startX = Random.int(0, cols - 1);
          const startY = Random.int(0, rows - 1);
          const angle = (i * Math.PI / 2) + (Math.PI / 4);
          for (let j = 0; j < snareLength; j++) {
            const x = Math.floor(startX + Math.cos(angle) * j);
            const y = Math.floor(startY + Math.sin(angle) * j);
            if (x >= 0 && x < cols && y >= 0 && y < rows && grid[x] && grid[x][y]) {
              grid[x][y].life = Math.min(1.0, grid[x][y].life + intensity * 0.6);
              grid[x][y].hue = (hue + 60) % 360;
              grid[x][y].saturation = 60;
              grid[x][y].lightness = 70;
              grid[x][y].fadeSpeed = 0.008;
            }
          }
        }
        break;
      }
      case 'hihat': {
        const numSparkles = Math.floor(mapValue(intensity, 0, 1, 2, 6));
        for (let i = 0; i < numSparkles; i++) {
          const x = Random.int(0, cols - 1);
          const y = Random.int(0, rows - 1);
          if (grid[x] && grid[x][y]) {
            grid[x][y].life = Math.min(0.8, grid[x][y].life + intensity * 0.4);
            grid[x][y].hue = (hue + 120) % 360;
            grid[x][y].saturation = 40;
            grid[x][y].lightness = 75;
            grid[x][y].fadeSpeed = 0.01;
          }
        }
        break;
      }
      case 'clap': {
        const numColumns = Math.floor(mapValue(intensity, 0, 1, 2, 4));
        for (let i = 0; i < numColumns; i++) {
          const x = Random.int(0, cols - 1);
          const height = Math.floor(mapValue(intensity, 0, 1, 2, 5));
          for (let y = 0; y < height && y < rows; y++) {
            if (grid[x] && grid[x][y]) {
              grid[x][y].life = Math.min(0.9, grid[x][y].life + intensity * 0.5);
              grid[x][y].hue = (hue + 240) % 360;
              grid[x][y].saturation = 55;
              grid[x][y].lightness = 65;
              grid[x][y].fadeSpeed = 0.006;
            }
          }
          for (let y = rows - 1; y >= rows - height && y >= 0; y--) {
            if (grid[x] && grid[x][y]) {
              grid[x][y].life = Math.min(0.9, grid[x][y].life + intensity * 0.5);
              grid[x][y].hue = (hue + 240) % 360;
              grid[x][y].saturation = 55;
              grid[x][y].lightness = 65;
              grid[x][y].fadeSpeed = 0.006;
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  function triggerGridPattern(velocity = 1.0, isGrain = false, isLayer = false, transposeAmount = 0) {
    const transposeHueShift = isLayer ? mapValue(transposeAmount, -24, 24, -120, 120) : 0;
    let hue = (currentBaseHue + Random.float(-8, 8) + transposeHueShift + 360) % 360;

    if (isGrain) {
      if (Random.coinToss(0.12)) {
        const simpleColor = useSimpleStartColor();
        const grainHue = simpleColor ? simpleColor.hue : hue;
        const grainSaturation = simpleColor ? simpleColor.saturation : Random.float(35, 45);
        const grainLightness = simpleColor ? simpleColor.lightness : Random.float(45, 55);
        const x = Random.int(0, cols - 1);
        const y = Random.int(0, rows - 1);
        if (grid[x] && grid[x][y]) {
          grid[x][y].life = Math.min(0.6, grid[x][y].life + velocity * 0.2);
          grid[x][y].hue = grainHue;
          grid[x][y].saturation = grainSaturation;
          grid[x][y].lightness = grainLightness;
          grid[x][y].fadeSpeed = 0.005;
        }
      }
      return;
    }

    const simpleColor = useSimpleStartColor();
    if (simpleColor) {
      hue = simpleColor.hue;
    }

    const eventType = Math.random();
    const saturation = simpleColor ? simpleColor.saturation : Random.float(45, 60);
    const lightness = simpleColor ? simpleColor.lightness : Random.float(55, 65);
    const fadeSpeed = mapValue(velocity, 0.1, 0.7, 0.006, 0.003);

    if (eventType < 0.04) {
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const cell = grid[i][j];
          if (cell.life <= 0.2) {
            cell.life = Math.min(0.4, cell.life + velocity * 0.15);
            cell.hue = hue;
            cell.saturation = simpleColor ? simpleColor.saturation : 30;
            cell.lightness = simpleColor ? simpleColor.lightness : 40;
            cell.fadeSpeed = 0.002;
          }
        }
      }
      return;
    }

    const midX = Math.ceil(cols / 2);
    const midY = Math.ceil(rows / 2);
    const sizeMultiplier = isLayer ? 1.3 : 1.0;
    const w = Math.floor(Random.int(2, Math.floor(cols / 2.5)) * sizeMultiplier);
    const h = Math.floor(Random.int(1, 2) * sizeMultiplier);
    const sx = Random.int(0, Math.max(1, midX - w));
    const sy = Random.int(0, Math.max(1, midY - h));

    for (let x = sx; x < sx + w && x < cols; x++) {
      for (let y = sy; y < sy + h && y < rows; y++) {
        if (grid[x] && grid[x][y]) {
          const cellsToUpdate = [
            grid[x][y],
            grid[cols - 1 - x] && grid[cols - 1 - x][y],
            grid[x][rows - 1 - y],
            grid[cols - 1 - x] && grid[cols - 1 - x][rows - 1 - y],
          ].filter(Boolean);
          cellsToUpdate.forEach((cell) => {
            cell.life = Math.min(1.2, cell.life + velocity * 0.5);
            cell.hue = hue;
            cell.saturation = saturation;
            cell.lightness = lightness;
            cell.fadeSpeed = fadeSpeed;
          });
        }
      }
    }
  }

  function drawVisualizer() {
    if (!visualizerRunning) {
      visualizerAnimationId = null;
      return;
    }
    visualizerAnimationId = requestAnimationFrame(drawVisualizer);
    canvasCtx.fillStyle = `hsla(${currentBaseHue}, 50%, 10%, 1)`;
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    canvasCtx.fillStyle = 'rgba(0, 0, 0, 0.15)';
    canvasCtx.fillRect(0, 0, canvas.width, canvas.height);
    if (audioReadyChecker()) {
      for (let i = 0; i < cols; i++) {
        for (let j = 0; j < rows; j++) {
          const cell = grid[i][j];
          if (cell.life > 0) {
            cell.life -= cell.fadeSpeed;
            canvasCtx.fillStyle = `hsla(${cell.hue}, ${cell.saturation}%, ${cell.lightness}%, ${cell.life})`;
            canvasCtx.fillRect(i * GRID_SIZE, j * GRID_SIZE, GRID_SIZE, GRID_SIZE);
          } else {
            cell.life = 0;
          }
        }
      }
    }
  }

  function pauseVisualizer() {
    visualizerRunning = false;
    if (visualizerAnimationId) {
      cancelAnimationFrame(visualizerAnimationId);
      visualizerAnimationId = null;
    }
  }

  function resumeVisualizer() {
    if (visualizerRunning) return;
    visualizerRunning = true;
    if (!visualizerAnimationId) {
      drawVisualizer();
    }
  }

  function setBaseHue(value) {
    currentBaseHue = value;
  }

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      pauseVisualizer();
    } else if (visualizerRunning) {
      resumeVisualizer();
    }
  });
  drawVisualizer();

  return {
    triggerDrumVisual,
    triggerGridPattern,
    draw: drawVisualizer,
    pause: pauseVisualizer,
    resume: resumeVisualizer,
    setBaseHue,
    getBaseHue: () => currentBaseHue,
    resetSimpleColors: resetSimpleStartColors,
    useSimpleColor: useSimpleStartColor,
    playBoringSequence,
    setIsAudioReady: (fn) => {
      audioReadyChecker = typeof fn === 'function' ? fn : () => true;
    },
    isRunning: () => visualizerRunning,
  };
}
