/*
 * ThreeSistersSVF
 *
 * A custom filter module for Tone.js inspired by the Mannequins “Three Sisters” eurorack module.
 *
 * This implementation does not rely on Tone.Filter or any other built‑in filter nodes.  Instead it
 * implements three state‑variable filter (SVF) cores directly in JavaScript and runs them inside
 * an AudioWorkletProcessor.  Each core has its own cutoff but they all share a global resonance
 * parameter and a simple cross‑feedback matrix that links their behaviour.  The resulting node
 * exposes a single summed output and can be used just like any other Tone node.
 *
 * The core algorithm is based on the classic digital state variable filter topology where a
 * pair of integrators produce simultaneous high‑pass (HP), band‑pass (BP) and low‑pass (LP)
 * outputs.  For stability we compute the frequency coefficient α₁ = 2·sin(π·f_c/F_s) and
 * the damping coefficient α₂ = 1/Q for each core【508713880378709†L70-L79】.  On each sample the
 * intermediate values are updated via simple difference equations【508713880378709†L140-L149】.
 *
 * Usage:
 *   import * as Tone from 'tone';
 *   import ThreeSistersSVF from './three_sisters_svf.js';
 *
 *   const osc = new Tone.Oscillator(440, 'sawtooth').start();
 *   const sisters = new ThreeSistersSVF({ center: 600, span: 300, q: 8, feedback: 0.05 });
 *   await sisters.ready();
 *   osc.connect(sisters).toDestination();
 *
 * Parameters:
 *   center   – centre frequency (Hz) of the middle band
 *   span     – distance (Hz) between the centre band and the low/high bands
 *   q        – global resonance (Q factor).  Larger values yield a narrower band and
 *              stronger resonance.  Internally the damping coefficient is α₂ = 1/Q【508713880378709†L70-L79】.
 *   feedback – strength of the shared energy field and cross feedback.  Higher values
 *              increase interaction between bands but too much may cause instability.
 */

import * as Tone from 'tone';

const ToneAudioNode = Tone.ToneAudioNode;
if (!ToneAudioNode) {
  throw new Error('ThreeSistersSVF requires ToneAudioNode to be exposed on the Tone namespace');
}

// The text of the AudioWorkletProcessor is defined as a template literal so it can be passed
// into the AudioWorklet at runtime.  This avoids the need for a separate worklet file on disk.
const processorCode = `
class ThreeSistersSVFProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors () {
    // Define parameter descriptors so that automation can be attached if desired.  These
    // parameters are treated as k‑rate (constant within a render quantum).  They are also
    // updated via the message port when setters on the node are called.
    return [
      { name: 'center', defaultValue: 600, minValue: 20, maxValue: 20000, automationRate: 'k-rate' },
      { name: 'span',   defaultValue: 300, minValue: 0, maxValue: 10000, automationRate: 'k-rate' },
      { name: 'q',      defaultValue: 8,   minValue: 0.1, maxValue: 100, automationRate: 'k-rate' },
      { name: 'feedback', defaultValue: 0.05, minValue: 0.0, maxValue: 1.0, automationRate: 'k-rate' }
    ];
  }

  constructor (options) {
    super(options);
    // Internal state variables for each core.  Each SVF uses two integrators: one for the
    // band‑pass state (s1) and one for the low‑pass state (s2).  High‑pass is computed on
    // the fly and discarded.
    this._lowS1 = 0;   this._lowS2 = 0;
    this._centreS1 = 0; this._centreS2 = 0;
    this._highS1 = 0;  this._highS2 = 0;

    // Cached coefficients for each core.  They are recalculated whenever centre/span/q
    // parameters change.  Using α₁ = 2*sin(π·f_c/F_s) gives a good approximation for
    // discrete‑time integration【508713880378709†L70-L79】.  The damping coefficient α₂ = 1/Q controls
    // resonance【508713880378709†L70-L79】.
    this._lowAlpha1 = 0;
    this._centreAlpha1 = 0;
    this._highAlpha1 = 0;
    this._alpha2 = 1 / 8; // default Q of 8
    this._feedback = 0.05;
    this._span = 300;
    this._centreFreq = 600;

    // Precompute sample rate once for efficiency
    this._sampleRate = sampleRate;

    // Flag to indicate that coefficient recalculation is required.
    this._recalc = true;

    // Handle parameter updates coming from the node via postMessage.
    this.port.onmessage = (event) => {
      const data = event.data;
      if (data.type === 'update') {
        if (data.center !== undefined) this._centreFreq = data.center;
        if (data.span !== undefined)   this._span = data.span;
        if (data.q !== undefined)      this._alpha2 = 1 / Math.max(0.0001, data.q);
        if (data.feedback !== undefined) this._feedback = data.feedback;
        // Mark coefficients dirty
        this._recalc = true;
      }
    };
  }

  /**
   * Recalculate α₁ for each core based on the current centre frequency, span and sample
   * rate.  Frequencies are clamped to a safe range [20 Hz, 0.45·F_s] to avoid
   * numerical blow‑ups near Nyquist.
   */
  _updateCoefficients () {
    const nyq = this._sampleRate * 0.45;
    const centre = Math.min(nyq, Math.max(20, this._centreFreq));
    const lowF    = Math.min(nyq, Math.max(20, centre - this._span));
    const highF   = Math.min(nyq, Math.max(20, centre + this._span));
    // α₁ = 2·sin(π·f_c/F_s)【508713880378709†L70-L79】
    this._lowAlpha1    = 2 * Math.sin(Math.PI * lowF / this._sampleRate);
    this._centreAlpha1 = 2 * Math.sin(Math.PI * centre / this._sampleRate);
    this._highAlpha1   = 2 * Math.sin(Math.PI * highF / this._sampleRate);
    this._recalc = false;
  }

  /**
   * The DSP loop.  It processes one render quantum at a time.  Each input sample is
   * combined with a portion of the previous band‑pass outputs (shared energy field)
   * and a small cross‑feedback between bands.  Each SVF core is updated with its
   * own frequency coefficient.  The three resulting band‑pass signals are averaged
   * to form the final output sample.
   */
  process (inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) {
      // Nothing to process
      return true;
    }
    const inCh  = input[0];
    const outCh = output[0];
    // Recalculate filter coefficients if parameters have changed.
    if (this._recalc) {
      this._updateCoefficients();
    }
    // Local copies of state variables for speed
    let lowS1    = this._lowS1;
    let lowS2    = this._lowS2;
    let centreS1 = this._centreS1;
    let centreS2 = this._centreS2;
    let highS1   = this._highS1;
    let highS2   = this._highS2;
    const lowA    = this._lowAlpha1;
    const centreA = this._centreAlpha1;
    const highA   = this._highAlpha1;
    const alpha2  = this._alpha2;
    const fb      = this._feedback;
    for (let i = 0; i < inCh.length; i++) {
      const x = inCh[i];
      // Shared energy field: add a little of the sum of all band‑pass states back into
      // the input.  This couples the three filters and creates the feeling of
      // pulling on a common resonant structure.
      const sumBP = lowS1 + centreS1 + highS1;
      const sharedDrive = x + sumBP * fb;
      // Cross‑feedback: small amounts of adjacent band‑pass signals are fed into
      // neighbouring cores.  High→Low, Low→Centre, Centre→High.  The gain is
      // controlled by the same feedback amount.
      const driveLow    = sharedDrive + highS1 * fb;
      const driveCentre = sharedDrive + lowS1  * fb;
      const driveHigh   = sharedDrive + centreS1 * fb;
      // Low core
      let hp = driveLow - lowS2 - alpha2 * lowS1;
      let bp = lowA * hp + lowS1;
      let lp = lowA * bp + lowS2;
      lowS1 = bp;
      lowS2 = lp;
      const lowBP = bp;
      // Centre core
      hp = driveCentre - centreS2 - alpha2 * centreS1;
      bp = centreA * hp + centreS1;
      lp = centreA * bp + centreS2;
      centreS1 = bp;
      centreS2 = lp;
      const centreBP = bp;
      // High core
      hp = driveHigh - highS2 - alpha2 * highS1;
      bp = highA * hp + highS1;
      lp = highA * bp + highS2;
      highS1 = bp;
      highS2 = lp;
      const highBP = bp;
      // Mix band‑pass outputs.  Equal weights (1/3) prevent excessive gain.
      outCh[i] = (lowBP + centreBP + highBP) / 3;
    }
    // Store updated states back on the processor instance.
    this._lowS1    = lowS1;
    this._lowS2    = lowS2;
    this._centreS1 = centreS1;
    this._centreS2 = centreS2;
    this._highS1   = highS1;
    this._highS2   = highS2;
    return true;
  }
}

// Register the processor under a unique name.
registerProcessor('three-sisters-svf-processor', ThreeSistersSVFProcessor);
`;

/**
 * ThreeSistersSVF node class.  This extends Tone.AudioNode and wraps an
 * AudioWorkletNode running the custom processor defined above.  Parameters can be
 * updated at runtime and the node behaves like any other Tone.js node with
 * `input` and `output` properties.
 */
export default class ThreeSistersSVF extends ToneAudioNode {
  /**
   * Construct a ThreeSistersSVF node.
   *
   * @param {Object} options Configuration options:
   *  - center (Hz)   Centre frequency of the middle band (default 600)
   *  - span (Hz)     Frequency difference between centre and low/high bands (default 300)
   *  - q             Global Q (resonance) factor (default 8)
   *  - feedback      Amount of shared and cross‑feedback (default 0.05)
   */
  constructor (options = {}) {
    super();
    const defaults = {
      center: 600,
      span: 300,
      q: 8,
      feedback: 0.05
    };
    // Merge defaults
    this._options = Object.assign({}, defaults, options);
    // Expose single input and output (Tone.js expects `input` and `output` AudioNodes)
    this.input  = new Tone.Gain();
    this.output = new Tone.Gain();
    // Placeholders for the underlying AudioWorkletNode and load promise
    this._workletNode = null;
    this._readyPromise = this._initWorklet();
  }

  /**
   * Load the AudioWorkletProcessor code and create the internal AudioWorkletNode.  This
   * method is invoked automatically on construction.  It returns a promise that
   * resolves when the node is ready.  Consumers may call `await sisters.ready()`
   * before connecting to ensure the processor has been registered.
   */
  async _initWorklet () {
    // Guard against running on unsupported browsers
    const context = Tone.getContext();
    if (!context || !context.audioWorklet) {
      throw new Error('ThreeSistersSVF: AudioWorklet is not supported in this environment');
    }
    // Load the processor only once per AudioContext
    if (!ThreeSistersSVF._workletLoaded) {
      const blob = new Blob([processorCode], { type: 'application/javascript' });
      const url  = URL.createObjectURL(blob);
      await context.audioWorklet.addModule(url);
      ThreeSistersSVF._workletLoaded = true;
    }
    // Create the AudioWorkletNode instance
    this._workletNode = new AudioWorkletNode(context, 'three-sisters-svf-processor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      parameterData: {
        center: this._options.center,
        span: this._options.span,
        q: this._options.q,
        feedback: this._options.feedback
      }
    });
    // Connect the node into the Tone.js signal graph
    this.input.connect(this._workletNode);
    this._workletNode.connect(this.output);
  }

  /**
   * Return a promise that resolves when the underlying AudioWorkletNode has been
   * created.  Useful when constructing the node asynchronously.
   */
  async ready () {
    return this._readyPromise;
  }

  /**
   * Getter/setter for the centre frequency.  Changing this property retunes all
   * three cores around the new centre frequency.
   */
  get center () {
    return this._options.center;
  }
  set center (value) {
    this._options.center = value;
    if (this._workletNode) {
      this._workletNode.parameters.get('center').value = value;
      this._workletNode.port.postMessage({ type: 'update', center: value });
    }
  }

  /**
   * Getter/setter for the span.  Span is the distance in Hz between the centre
   * band and the low/high bands.
   */
  get span () {
    return this._options.span;
  }
  set span (value) {
    this._options.span = value;
    if (this._workletNode) {
      this._workletNode.parameters.get('span').value = value;
      this._workletNode.port.postMessage({ type: 'update', span: value });
    }
  }

  /**
   * Getter/setter for the global Q (resonance) parameter.  Larger Q yields a
   * narrower band and stronger resonance.  Internally the damping coefficient is
   * α₂ = 1/Q【508713880378709†L70-L79】.
   */
  get q () {
    return this._options.q;
  }
  set q (value) {
    this._options.q = value;
    if (this._workletNode) {
      this._workletNode.parameters.get('q').value = value;
      this._workletNode.port.postMessage({ type: 'update', q: value });
    }
  }

  /**
   * Getter/setter for the feedback.  This controls both the shared energy field
   * (self‑drive) and the cross‑feedback coupling between the three cores.  Higher
   * values create more interaction but may lead to instability if set too high.
   */
  get feedback () {
    return this._options.feedback;
  }
  set feedback (value) {
    this._options.feedback = value;
    if (this._workletNode) {
      this._workletNode.parameters.get('feedback').value = value;
      this._workletNode.port.postMessage({ type: 'update', feedback: value });
    }
  }

  /**
   * Convenience method to retune the filter bands.  Calling update(center, span)
   * sets both the centre frequency and the span in one call.
   * @param {number} center The new centre frequency in Hz
   * @param {number} span   The new span in Hz
   */
  update (center, span) {
    this.center = center;
    this.span   = span;
  }

  /**
   * Clean up and disconnect internal nodes.  This method should be called
   * explicitly when the filter is no longer needed.
   */
  dispose () {
    super.dispose();
    if (this._workletNode) {
      this._workletNode.port.postMessage({ type: 'update', feedback: 0 });
      this.input.disconnect();
      this._workletNode.disconnect();
      this._workletNode = null;
    }
  }
}
