import * as Tone from 'tone';
import { resolveBaseAudioContext } from '../utils/audioContext.js';

const ToneAudioNode = Tone.ToneAudioNode;
if (!ToneAudioNode) {
  throw new Error('SimpleThreeBandFilter requires ToneAudioNode to be available on Tone.js');
}

export default class SimpleThreeBandFilter extends ToneAudioNode {
  constructor(options = {}) {
    super();
    const defaults = {
      center: 600,
      span: 300,
      q: 8,
    };
    this._options = { ...defaults, ...options };
    this.input = new Tone.Gain();
    this.output = new Tone.Gain();

    const filterConfig = () => ({
      type: 'bandpass',
      frequency: this._options.center,
    });
    this._low = new Tone.Filter(filterConfig());
    this._centre = new Tone.Filter(filterConfig());
    this._high = new Tone.Filter(filterConfig());

    this._lowGain = new Tone.Gain(1 / 3);
    this._centreGain = new Tone.Gain(1 / 3);
    this._highGain = new Tone.Gain(1 / 3);

    this.input.connect(this._low);
    this.input.connect(this._centre);
    this.input.connect(this._high);

    this._low.connect(this._lowGain).connect(this.output);
    this._centre.connect(this._centreGain).connect(this.output);
    this._high.connect(this._highGain).connect(this.output);

    this._updateFrequencies();
    this._updateQ();
  }

  async ready() {
    return;
  }

  get center() {
    return this._options.center;
  }
  set center(value) {
    this._options.center = value;
    this._updateFrequencies();
  }

  get span() {
    return this._options.span;
  }
  set span(value) {
    this._options.span = value;
    this._updateFrequencies();
  }

  get q() {
    return this._options.q;
  }
  set q(value) {
    this._options.q = value;
    this._updateQ();
  }

  update(center, span) {
    if (center !== undefined) this.center = center;
    if (span !== undefined) this.span = span;
  }

  _updateFrequencies() {
    const raw = resolveBaseAudioContext();
    const nyquist = raw && raw.sampleRate ? raw.sampleRate / 2 : 20000;
    const centre = Math.min(nyquist, Math.max(20, this._options.center));
    const span = Math.max(0, this._options.span);
    const low = Math.max(20, centre - span);
    const high = Math.min(nyquist, centre + span);
    this._low.frequency.value = low;
    this._centre.frequency.value = centre;
    this._high.frequency.value = high;
  }

  _updateQ() {
    const q = Math.max(0.5, this._options.q);
    [this._low, this._centre, this._high].forEach((node) => {
      node.Q.value = q;
    });
  }

  dispose() {
    super.dispose();
    [this._low, this._centre, this._high, this._lowGain, this._centreGain, this._highGain, this.input, this.output].forEach((node) => {
      if (node && typeof node.dispose === 'function') {
        node.dispose();
      }
    });
  }
}
