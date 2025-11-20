export class Random {
  static float(min, max) {
    return Math.random() * (max - min) + min;
  }

  static int(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  static select(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  static coinToss(probability = 0.5) {
    return Math.random() < probability;
  }
}

const LAYER_FILTER_MIN_FREQ = 40;
const LAYER_FILTER_MAX_FREQ = 12000;

export function mapValue(value, inMin, inMax, outMin, outMax) {
  return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}

export function mapLayerFilterValue(value) {
  const clamped = Math.min(Math.max(parseFloat(value), 0), 1);
  const multiplier = LAYER_FILTER_MAX_FREQ / LAYER_FILTER_MIN_FREQ;
  return LAYER_FILTER_MIN_FREQ * Math.pow(multiplier, clamped);
}
