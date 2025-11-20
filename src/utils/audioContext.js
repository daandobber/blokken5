import * as Tone from 'tone';

export function resolveBaseAudioContext() {
  const BaseAudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
  const OfflineAudioContextCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const queue = [];
  const visited = new Set();
  if (Tone.context) {
    queue.push(Tone.context);
  }
  if (typeof Tone.getContext === 'function') {
    const ctx = Tone.getContext();
    if (ctx) queue.push(ctx);
  }
  while (queue.length) {
    const candidate = queue.shift();
    if (!candidate || visited.has(candidate)) continue;
    visited.add(candidate);
    if ((BaseAudioContextCtor && candidate instanceof BaseAudioContextCtor) ||
        (OfflineAudioContextCtor && candidate instanceof OfflineAudioContextCtor)) {
      return candidate;
    }
    if (candidate.rawContext) queue.push(candidate.rawContext);
    if (candidate.context) queue.push(candidate.context);
    if (candidate._context) queue.push(candidate._context);
  }
  return null;
}
