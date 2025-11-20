        // --- Inlined Three Sisters Filter ---
        /*
         * ThreeSistersSVF
         *
         * A custom filter module for Tone.js inspired by the Mannequins â€œThree Sistersâ€ eurorack module.
         *
         * This implementation does not rely on Tone.Filter or any other builtâ€‘in filter nodes.  Instead it
         * implements three stateâ€‘variable filter (SVF) cores directly in JavaScript and runs them inside
         * an AudioWorkletProcessor.  Each core has its own cutoff but they all share a global resonance
         * parameter and a simple crossâ€‘feedback matrix that links their behaviour.  The resulting node
         * exposes a single summed output and can be used just like any other Tone node.
         *
         * The core algorithm is based on the classic digital state variable filter topology where a
         * pair of integrators produce simultaneous highâ€‘pass (HP), bandâ€‘pass (BP) and lowâ€‘pass (LP)
         * outputs.  For stability we compute the frequency coefficient Î±â‚ = 2Â·sin(Ï€Â·f_c/F_s) and
         * the damping coefficient Î±â‚‚ = 1/Q for each coreã€508713880378709â€ L70-L79ã€‘.  On each sample the
         * intermediate values are updated via simple difference equationsã€508713880378709â€ L140-L149ã€‘.
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
         *   center   â€“ centre frequency (Hz) of the middle band
         *   span     â€“ distance (Hz) between the centre band and the low/high bands
         *   q        â€“ global resonance (Q factor).  Larger values yield a narrower band and
         *              stronger resonance.  Internally the damping coefficient is Î±â‚‚ = 1/Qã€508713880378709â€ L70-L79ã€‘.
         *   feedback â€“ strength of the shared energy field and cross feedback.  Higher values
         *              increase interaction between bands but too much may cause instability.
         */
        
        const Tone = (() => {
          if (typeof globalThis !== 'undefined' && globalThis.Tone) {
            return globalThis.Tone;
          }
          throw new Error('ThreeSistersSVF requires Tone.js to be loaded before the module is imported');
        })();
        const ToneAudioNode = Tone.ToneAudioNode || Tone.AudioNode;
        if (!ToneAudioNode) {
          throw new Error('ThreeSistersSVF requires ToneAudioNode to be exposed on the Tone namespace');
        }

        function resolveBaseAudioContext() {
          const BaseAudioContextCtor = globalThis.AudioContext || globalThis.webkitAudioContext;
          const OfflineAudioContextCtor = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
          const queue = [];
          const visited = new Set();
          if (Tone.context) queue.push(Tone.context);
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
        
        // The text of the AudioWorkletProcessor is defined as a template literal so it can be passed
        // into the AudioWorklet at runtime.  This avoids the need for a separate worklet file on disk.
        const processorCode = `
        class ThreeSistersSVFProcessor extends AudioWorkletProcessor {
          static get parameterDescriptors () {
            // Define parameter descriptors so that automation can be attached if desired.  These
            // parameters are treated as kâ€‘rate (constant within a render quantum).  They are also
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
            // bandâ€‘pass state (s1) and one for the lowâ€‘pass state (s2).  Highâ€‘pass is computed on
            // the fly and discarded.
            this._lowS1 = 0;   this._lowS2 = 0;
            this._centreS1 = 0; this._centreS2 = 0;
            this._highS1 = 0;  this._highS2 = 0;
        
            // Cached coefficients for each core.  They are recalculated whenever centre/span/q
            // parameters change.  Using Î±â‚ = 2*sin(Ï€Â·f_c/F_s) gives a good approximation for
            // discreteâ€‘time integrationã€508713880378709â€ L70-L79ã€‘.  The damping coefficient Î±â‚‚ = 1/Q controls
            // resonanceã€508713880378709â€ L70-L79ã€‘.
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
           * Recalculate Î±â‚ for each core based on the current centre frequency, span and sample
           * rate.  Frequencies are clamped to a safe range [20 Hz, 0.45Â·F_s] to avoid
           * numerical blowâ€‘ups near Nyquist.
           */
          _updateCoefficients () {
            const nyq = this._sampleRate * 0.45;
            const centre = Math.min(nyq, Math.max(20, this._centreFreq));
            const lowF    = Math.min(nyq, Math.max(20, centre - this._span));
            const highF   = Math.min(nyq, Math.max(20, centre + this._span));
            // Î±â‚ = 2Â·sin(Ï€Â·f_c/F_s)ã€508713880378709â€ L70-L79ã€‘
            this._lowAlpha1    = 2 * Math.sin(Math.PI * lowF / this._sampleRate);
            this._centreAlpha1 = 2 * Math.sin(Math.PI * centre / this._sampleRate);
            this._highAlpha1   = 2 * Math.sin(Math.PI * highF / this._sampleRate);
            this._recalc = false;
          }
        
          /**
           * The DSP loop.  It processes one render quantum at a time.  Each input sample is
           * combined with a portion of the previous bandâ€‘pass outputs (shared energy field)
           * and a small crossâ€‘feedback between bands.  Each SVF core is updated with its
           * own frequency coefficient.  The three resulting bandâ€‘pass signals are averaged
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
              // Shared energy field: add a little of the sum of all bandâ€‘pass states back into
              // the input.  This couples the three filters and creates the feeling of
              // pulling on a common resonant structure.
              const sumBP = lowS1 + centreS1 + highS1;
              const sharedDrive = x + sumBP * fb;
              // Crossâ€‘feedback: small amounts of adjacent bandâ€‘pass signals are fed into
              // neighbouring cores.  Highâ†’Low, Lowâ†’Centre, Centreâ†’High.  The gain is
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
              // Mix bandâ€‘pass outputs.  Equal weights (1/3) prevent excessive gain.
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
        class ThreeSistersSVF extends ToneAudioNode {
          /**
           * Construct a ThreeSistersSVF node.
           *
           * @param {Object} options Configuration options:
           *  - center (Hz)   Centre frequency of the middle band (default 600)
           *  - span (Hz)     Frequency difference between centre and low/high bands (default 300)
           *  - q             Global Q (resonance) factor (default 8)
           *  - feedback      Amount of shared and crossâ€‘feedback (default 0.05)
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
            const audioContext = resolveBaseAudioContext();
            if (!audioContext || !audioContext.audioWorklet) {
              throw new Error('ThreeSistersSVF: AudioWorklet is not supported in this environment');
            }
            // Load the processor only once per AudioContext
            if (!ThreeSistersSVF._workletLoaded) {
              const blob = new Blob([processorCode], { type: 'application/javascript' });
              const url  = URL.createObjectURL(blob);
              await audioContext.audioWorklet.addModule(url);
              ThreeSistersSVF._workletLoaded = true;
            }
            // Create the AudioWorkletNode instance
            this._workletNode = new AudioWorkletNode(audioContext, 'three-sisters-svf-processor', {
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
           * Î±â‚‚ = 1/Qã€508713880378709â€ L70-L79ã€‘.
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
           * (selfâ€‘drive) and the crossâ€‘feedback coupling between the three cores.  Higher
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

        // Lightweight Tone.js fallback so span/frequency/Q sliders still have an audible effect when
        // AudioWorklet isn't available (e.g. older browsers or strict autoplay contexts).
        class SimpleThreeBandFilter extends ToneAudioNode {
          constructor (options = {}) {
            super();
            const defaults = {
              center: 600,
              span: 300,
              q: 8
            };
            this._options = Object.assign({}, defaults, options);
            this.input = new Tone.Gain();
            this.output = new Tone.Gain();

            const filterConfig = () => ({
              type: 'bandpass',
              frequency: this._options.center
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

          async ready () {
            return;
          }

          get center () {
            return this._options.center;
          }
          set center (value) {
            this._options.center = value;
            this._updateFrequencies();
          }

          get span () {
            return this._options.span;
          }
          set span (value) {
            this._options.span = value;
            this._updateFrequencies();
          }

          get q () {
            return this._options.q;
          }
          set q (value) {
            this._options.q = value;
            this._updateQ();
          }

          update (center, span) {
            if (center !== undefined) this.center = center;
            if (span !== undefined) this.span = span;
          }

          _updateFrequencies () {
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

          _updateQ () {
            const q = Math.max(0.5, this._options.q);
            [this._low, this._centre, this._high].forEach(node => {
              node.Q.value = q;
            });
          }

          dispose () {
            super.dispose();
            [this._low, this._centre, this._high, this._lowGain, this._centreGain, this._highGain, this.input, this.output].forEach(node => {
              if (node && node.dispose) {
                node.dispose();
              }
            });
          }
        }
        
        // --- UTILITY CLASSES ---
        class Random {
            static float(min, max) { return Math.random() * (max - min) + min; }
            static int(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
            static select(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
            static coinToss(probability = 0.5) { return Math.random() < probability; }
        }
        
        const LAYER_FILTER_MIN_FREQ = 40;
        const LAYER_FILTER_MAX_FREQ = 12000;

        function mapValue(value, inMin, inMax, outMin, outMax) {
            return (value - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
        }

        function mapLayerFilterValue(value) {
            const clamped = Math.min(Math.max(parseFloat(value), 0), 1);
            const multiplier = LAYER_FILTER_MAX_FREQ / LAYER_FILTER_MIN_FREQ;
            return LAYER_FILTER_MIN_FREQ * Math.pow(multiplier, clamped);
        }

        const SYNTH_FILTER_FREQUENCY_MIN = 80;
        const SYNTH_FILTER_FREQUENCY_MAX = 6000;
        const SYNTH_FILTER_SPAN_MIN = 40;
        const SYNTH_FILTER_SPAN_MAX = 1800;
        const SYNTH_FILTER_DEFAULT_FREQUENCY = 1200;
        const SYNTH_FILTER_DEFAULT_SPAN = 400;
        const SYNTH_FILTER_Q_MIN = 2;
        const SYNTH_FILTER_Q_MAX = 30;
        const SYNTH_FILTER_DEFAULT_Q = 12;
        const SYNTH_FILTER_DEFAULT_FEEDBACK = 0.08;
        const SYNTH_FILTER_MIX_DEFAULT = 1;

        // Simple palette to make the very first visual impressions super basic.
        const SIMPLE_START_COLORS = [
            { hue: 0, saturation: 80, lightness: 55 },    // rood
            { hue: 55, saturation: 90, lightness: 60 },   // geel
            { hue: 225, saturation: 80, lightness: 50 },  // blauw
            { hue: 120, saturation: 65, lightness: 50 },  // groen
            { hue: 0, saturation: 0, lightness: 6 },      // zwart
            { hue: 0, saturation: 0, lightness: 95 }      // wit
        ];
        let simpleColorIndex = 0;

        let synthFilter = null;
        let synthFilterIsSVF = false;
        let synthFilterMixAmount = SYNTH_FILTER_MIX_DEFAULT;
        let synthFilterDryGain = null;
        let synthFilterWetGain = null;
        let synthFilterBlendBus = null;
        let layerFilter = null;

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

        function clampSynthFilterSpan(span) {
            return Math.min(Math.max(span, SYNTH_FILTER_SPAN_MIN), SYNTH_FILTER_SPAN_MAX);
        }

        function applySynthFilterSettings(settings = {}) {
            if (!synthFilter) return;
            const { frequency, span, q } = settings;
            const clampedFrequency = frequency !== undefined ? Math.min(Math.max(frequency, SYNTH_FILTER_FREQUENCY_MIN), SYNTH_FILTER_FREQUENCY_MAX) : undefined;
            const clampedSpan = span !== undefined ? clampSynthFilterSpan(span) : undefined;
            const clampedQ = q !== undefined ? Math.min(Math.max(q, SYNTH_FILTER_Q_MIN), SYNTH_FILTER_Q_MAX) : undefined;
            if (synthFilterIsSVF) {
                if (clampedFrequency !== undefined) synthFilter.center = clampedFrequency;
                if (clampedSpan !== undefined) synthFilter.span = clampedSpan;
                if (clampedQ !== undefined) synthFilter.q = clampedQ;
            } else if (typeof synthFilter.update === 'function') {
                synthFilter.update(clampedFrequency, clampedSpan);
                if (clampedQ !== undefined && 'q' in synthFilter) {
                    synthFilter.q = clampedQ;
                }
            } else if (synthFilter.frequency) {
                if (clampedFrequency !== undefined) synthFilter.frequency.value = clampedFrequency;
                if (clampedQ !== undefined && synthFilter.Q) synthFilter.Q.value = clampedQ;
            }
        }

        function applyLayerLowpassCenter(centerFreq) {
            if (!layerFilter) return;
            if (layerFilter.frequency) {
                layerFilter.frequency.value = centerFreq;
            }
        }

        function canUseThreeSistersSVF() {
            const raw = resolveBaseAudioContext();
            return Boolean(
                raw &&
                raw.audioWorklet &&
                typeof raw.audioWorklet.addModule === 'function' &&
                typeof AudioWorkletNode !== 'undefined'
            );
        }

        // --- VISUALIZER SETUP ---
        const canvas = document.getElementById('visualizerCanvas');
        const canvasCtx = canvas.getContext('2d');
        let visualizerAnimationId;
        let visualizerRunning = true;
        const GRID_SIZE = 25;
        let grid = [];
        let cols, rows;
        let currentBaseHue = 0;
        const BORING_WORD = 'BORING';
        const BORING_FONT = {
            B: ['11110','10001','11110','10001','10001','11110','00000'],
            O: ['01110','10001','10001','10001','10001','01110','00000'],
            R: ['11110','10001','11110','10010','10010','10010','00000'],
            I: ['11111','00100','00100','00100','00100','11111','00000'],
            N: ['10001','11001','10101','10011','10001','10001','00000'],
            G: ['01110','10001','10000','10011','10001','01110','00000']
        };
        const BORING_LETTER_WIDTH = 5;
        const BORING_LETTER_HEIGHT = 7;
        const BORING_LETTER_SPACING = 2;
        let boringSequencePromise = null;

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
        resizeCanvas();
        window.addEventListener('resize', resizeCanvas);

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
            boringSequencePromise = new Promise(resolve => {
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
        
        // --- TONE.JS APPLICATIE ---
        const DRUM_SCHEDULE_EPSILON = 0.002;
        let drumLastTrigger = { kick: 0, snare: 0, hihat: 0, clap: 0 };

        function getDrumScheduleTime(drum, targetTime) {
            const last = drumLastTrigger[drum] || 0;
            return Math.max(targetTime, last + DRUM_SCHEDULE_EPSILON);
        }

        function safeTriggerAttackRelease(node, drum, note, duration, time, velocity) {
            if (!node || node.disposed) return;
            let safeTime = getDrumScheduleTime(drum, time);
            let attempts = 0;
            while (attempts < 5) {
                try {
                    if (note !== undefined && note !== null) {
                        node.triggerAttackRelease(note, duration, safeTime, velocity);
                    } else {
                        node.triggerAttackRelease(duration, safeTime, velocity);
                    }
                    drumLastTrigger[drum] = safeTime;
                    return;
                } catch (err) {
                    const message = err && err.message;
                    if (message && (message.includes('Start time must be strictly greater') || message.includes('greater than or equal'))) {
                        safeTime = Math.max(safeTime + DRUM_SCHEDULE_EPSILON, (drumLastTrigger[drum] || 0) + DRUM_SCHEDULE_EPSILON);
                        attempts++;
                        continue;
                    }
                    throw err;
                }
            }
        }

        let isSetup = false;
        let synth, layerSynth, notePart, granularPart, reverb, masterVolume, layerVolume, drumBus, lowTap;
        let kickDrum, snareDrum, hihatDrum, clapDrum;
        let kickVolume, snareVolume, hihatVolume, clapVolume;
        let drumPart;
        let delays = [];
        const SOUND_FADE_DURATION = 0.18;
        const SILENCE_DB = -60;
        const DEFAULT_MASTER_DB = -18;
        const MAX_DELAY_WET = 0.6;
        const SPREAD_DETUNE_RANGE = 12;
        const MIN_GRAIN_COUNT = 8;
        const MAX_GRAIN_COUNT = 220;
        const DRUM_VOLUME_DB_RANGE = { min: -60, max: -6 };
        const KICK_VOLUME_DB_RANGE = { min: -60, max: 0 };
        const HIHAT_DB_RANGE = { min: -30, max: -6 };
        const CLAP_DB_RANGE = { min: -18, max: 0 };
        const CLAP_FLAM_OFFSET = Tone.Time('64n').toSeconds();
        const MAX_HUMANIZE_TIME = 0.07;
        const FLUTTER_WOW_MAX_DEPTH = 40;
        const FLUTTER_WOW_RATE_RANGE = { min: 0.08, max: 1.1 };
        const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        const SCALE_DEFINITIONS = [
            { name: 'Major', semitones: [0, 2, 4, 5, 7, 9, 11] },
            { name: 'Natural Minor', semitones: [0, 2, 3, 5, 7, 8, 10] },
            { name: 'Blues Minor', semitones: [0, 3, 5, 6, 7, 10] },
            { name: 'Hungarian Minor', semitones: [0, 2, 3, 6, 7, 8, 11] },
            { name: 'Phrygian', semitones: [0, 1, 3, 5, 7, 8, 10] }
        ];
        const PATTERN_STRUCTURE_MEASURES = 16;
        let currentPatternStructure = null;
        let patternPlaybackLength = 4;
        let scaleCyclePosition = 0;
        const DRUM_FILTER_SETTINGS = {
            kick: { type: 'lowpass', frequency: 220, rolloff: -48, Q: 0.9 },
            snare: { type: 'bandpass', frequency: 1900, rolloff: -24, Q: 1.1 },
            hihat: { type: 'highpass', frequency: 6500, rolloff: -24, Q: 0.7 },
            clap: { type: 'bandpass', frequency: 1800, rolloff: -24, Q: 1.2 }
        };
        const DEFAULT_DRUM_FILTER_BYPASS = {
            kick: true,
            snare: false,
            hihat: false,
            clap: false
        };
        let drumFilters = {
            kick: null,
            snare: null,
            hihat: null,
            clap: null
        };
        let drumFilterBypassStates = { ...DEFAULT_DRUM_FILTER_BYPASS };
        let flutterWowLFO = null;
        const drumVolumeSliders = {
            kick: document.getElementById('kickVolume'),
            snare: document.getElementById('snareVolume'),
            hihat: document.getElementById('hihatVolume'),
            clap: document.getElementById('clapVolume')
        };
        const drumFilterSliders = {
            kick: document.getElementById('kickFilter'),
            snare: document.getElementById('snareFilter'),
            hihat: document.getElementById('hihatFilter'),
            clap: document.getElementById('clapFilter')
        };
        const drumChanceSliders = {
            kick: document.getElementById('kickChance'),
            snare: document.getElementById('snareChance'),
            hihat: document.getElementById('hihatChance'),
            clap: document.getElementById('clapChance')
        };
        const drumFilterBypassButtons = {};
        const DRUM_FILTER_RANGES = {
            kick: { min: 40, max: 320 },
            snare: { min: 400, max: 4000 },
            hihat: { min: 3000, max: 14000 },
            clap: { min: 500, max: 5000 }
        };
        let drumFilterTargets = {
            kick: DRUM_FILTER_SETTINGS.kick.frequency,
            snare: DRUM_FILTER_SETTINGS.snare.frequency,
            hihat: DRUM_FILTER_SETTINGS.hihat.frequency,
            clap: DRUM_FILTER_SETTINGS.clap.frequency
        };
        const DRUM_DEFAULT_DB = DEFAULT_MASTER_DB;
        let drumsMuted = false;
        let isVisualizerFrozen = false;
        let previousUILayoutState = null;

        function applyDrumFilterTarget(drum) {
            const node = drumFilters[drum];
            if (node && !node.disposed && drumFilterTargets[drum] !== undefined) {
                node.frequency.value = drumFilterTargets[drum];
            }
        }

        function updateDrumFilterFrequency(drum) {
            const slider = drumFilterSliders[drum];
            if (!slider) return;
            const range = DRUM_FILTER_RANGES[drum] || { min: 20, max: 20000 };
            const value = Math.min(Math.max(parseFloat(slider.value) || range.min, range.min), range.max);
            drumFilterTargets[drum] = value;
            applyDrumFilterTarget(drum);
        }

        function getDrumChanceValue(drum) {
            const slider = drumChanceSliders[drum];
            if (!slider) return 1;
            const raw = Math.min(Math.max(parseFloat(slider.value) || 100, 0), 100);
            return raw / 100;
        }

        function disposeDrumFilters() {
            Object.keys(drumFilters).forEach(key => {
                const node = drumFilters[key];
                if (node && !node.disposed) {
                    node.disconnect();
                    node.dispose();
                }
                drumFilters[key] = null;
            });
        }

        function maybeCreateDrumFilter(filterKey) {
            if (!DRUM_FILTER_SETTINGS[filterKey]) return null;
            if (isDrumFilterBypassed(filterKey)) {
                return null;
            }
            if (!drumFilters[filterKey] || drumFilters[filterKey].disposed) {
                drumFilters[filterKey] = new Tone.Filter(DRUM_FILTER_SETTINGS[filterKey]);
                applyDrumFilterTarget(filterKey);
            }
            return drumFilters[filterKey];
        }

        function createDrumFilters() {
            disposeDrumFilters();
            Object.keys(DRUM_FILTER_SETTINGS).forEach(key => {
                if (isDrumFilterBypassed(key)) {
                    drumFilters[key] = null;
                    return;
                }
                drumFilters[key] = new Tone.Filter(DRUM_FILTER_SETTINGS[key]);
                applyDrumFilterTarget(key);
            });
        }

        function connectDrumToVolume({ drumNode, filterKey, volumeNode, tapLow = false }) {
            if (!drumNode || !volumeNode || !drumBus) return;
            drumNode.disconnect();
            volumeNode.disconnect();
            let filterNode = drumFilters[filterKey];
            if (!filterNode && DRUM_FILTER_SETTINGS[filterKey]) {
                filterNode = maybeCreateDrumFilter(filterKey);
            }
            const shouldBypass = !filterNode;
            if (!shouldBypass) {
                filterNode.disconnect();
                drumNode.connect(filterNode);
                filterNode.connect(volumeNode);
                applyDrumFilterTarget(filterKey);
            } else {
                if (filterNode) {
                    filterNode.disconnect();
                }
                drumNode.connect(volumeNode);
            }
            volumeNode.connect(drumBus);
            if (tapLow && lowTap) {
                volumeNode.connect(lowTap);
            }
        }

        function wireDrumRouting() {
            if (!drumBus) return;
            refreshSingleDrumRouting('kick');
            refreshSingleDrumRouting('snare');
            refreshSingleDrumRouting('hihat');
            refreshSingleDrumRouting('clap');
        }

        function refreshSingleDrumRouting(drum) {
            if (!drumBus) return;
            switch (drum) {
                case 'kick':
                    connectDrumToVolume({ drumNode: kickDrum, filterKey: 'kick', volumeNode: kickVolume, tapLow: true });
                    break;
                case 'snare':
                    connectDrumToVolume({ drumNode: snareDrum, filterKey: 'snare', volumeNode: snareVolume });
                    break;
                case 'hihat':
                    connectDrumToVolume({ drumNode: hihatDrum, filterKey: 'hihat', volumeNode: hihatVolume });
                    break;
                case 'clap':
                    connectDrumToVolume({ drumNode: clapDrum, filterKey: 'clap', volumeNode: clapVolume });
                    break;
            }
        }

        function disconnectSynthRouting() {
            if (masterVolume) masterVolume.disconnect();
            if (synthFilterDryGain) synthFilterDryGain.disconnect();
            if (synthFilterWetGain) synthFilterWetGain.disconnect();
            if (synthFilterBlendBus) synthFilterBlendBus.disconnect();
            if (synthFilter && !synthFilter.disposed) {
                synthFilter.disconnect();
            }
        }

        function ensureSynthFilterMixNodes() {
            if (!synthFilterDryGain || synthFilterDryGain.disposed) {
                synthFilterDryGain = new Tone.Gain(1);
            }
            if (!synthFilterWetGain || synthFilterWetGain.disposed) {
                synthFilterWetGain = new Tone.Gain(1);
            }
            if (!synthFilterBlendBus || synthFilterBlendBus.disposed) {
                synthFilterBlendBus = new Tone.Gain(1);
            }
        }

        function applySynthFilterMixLevels() {
            if (synthFilterDryGain && !synthFilterDryGain.disposed) {
                synthFilterDryGain.gain.value = 1 - synthFilterMixAmount;
            }
            if (synthFilterWetGain && !synthFilterWetGain.disposed) {
                synthFilterWetGain.gain.value = synthFilterMixAmount;
            }
        }

        function setSynthFilterMixAmount(amount) {
            const clamped = Math.min(Math.max(amount, 0), 1);
            synthFilterMixAmount = clamped;
            applySynthFilterMixLevels();
        }

        function connectSourceToEffects(source) {
            if (!source) return;
            source.connect(reverb);
            delays.forEach(delay => source.connect(delay));
        }

        function refreshSynthRouting() {
            if (!masterVolume || !reverb) return;
            disconnectSynthRouting();
            ensureSynthFilterMixNodes();
            if (!synthFilterBlendBus) return;
            masterVolume.connect(synthFilterDryGain);
            synthFilterDryGain.connect(synthFilterBlendBus);
            if (synthFilter && !synthFilter.disposed) {
                masterVolume.connect(synthFilter);
                synthFilter.connect(synthFilterWetGain);
                synthFilterWetGain.connect(synthFilterBlendBus);
            }
            connectSourceToEffects(synthFilterBlendBus);
            applySynthFilterMixLevels();
        }

        const RHYTHM_PATTERNS = [
            {
                label: 'Trip Hop',
                kick: [[0, 0, 0, 1.0], [2, 2, 0, 0.9]],
                snare: [[1, 0, 0, 0.8], [3, 1, 0, 0.7]],
                hihat: [[0, 2, 0, 0.3], [1, 2, 0, 0.4], [2, 2, 0, 0.3], [3, 2, 0, 0.5]],
                clap: []
            },
            {
                label: 'Chillhop',
                kick: [[0, 0, 0, 1.0], [1, 3, 0, 0.6], [2, 2, 0, 0.8]],
                snare: [[1, 2, 0, 0.7], [3, 0, 0, 0.7]],
                hihat: [[0, 2, 0, 0.35], [0, 3, 0, 0.25], [1, 2, 0, 0.4], [1, 3, 0, 0.3], [2, 2, 0, 0.4], [3, 2, 0, 0.45]],
                clap: [[1, 2, 2, 0.3], [3, 2, 2, 0.3]]
            },
            {
                label: 'Boom Bap',
                kick: [[0, 0, 0, 1.0], [1, 2, 0, 0.6], [2, 3, 0, 0.8]],
                snare: [[1, 0, 0, 0.9], [3, 0, 0, 0.9]],
                hihat: [[0, 2, 0, 0.4], [0, 3, 2, 0.3], [1, 2, 0, 0.5], [2, 2, 0, 0.4], [2, 3, 2, 0.3], [3, 2, 0, 0.5]],
                clap: [[1, 0, 2, 0.3], [3, 0, 2, 0.3]]
            },
            {
                label: 'Afrobeat',
                kick: [[0, 0, 0, 1.0], [1, 1, 0, 0.8], [2, 3, 0, 0.7], [3, 1, 0, 0.9]],
                snare: [[1, 2, 0, 0.65], [2, 0, 2, 0.5], [3, 2, 0, 0.65]],
                hihat: [[0, 2, 0, 0.45], [1, 1, 0, 0.35], [1, 3, 0, 0.4], [2, 2, 0, 0.45], [3, 1, 0, 0.35], [3, 3, 0, 0.4]],
                clap: [[1, 2, 1, 0.45], [3, 2, 1, 0.45]]
            },
            {
                label: 'Breakbeat',
                kick: [[0, 0, 0, 1.0], [0, 3, 0, 0.7], [2, 2, 0, 0.9], [3, 1, 0, 0.6]],
                snare: [[1, 0, 0, 0.9], [2, 0, 2, 0.5], [3, 0, 0, 0.8]],
                hihat: [[0, 2, 0, 0.5], [1, 2, 0, 0.6], [1, 3, 0, 0.4], [2, 2, 0, 0.5], [3, 2, 0, 0.6], [3, 3, 0, 0.4]],
                clap: []
            },
            {
                label: 'Electro',
                kick: [[0, 0, 0, 1.0], [1, 2, 0, 0.9], [2, 0, 0, 1.0], [3, 2, 0, 0.9]],
                snare: [[1, 0, 0, 0.9], [3, 0, 0, 0.9]],
                hihat: [[0, 2, 0, 0.45], [0, 3, 0, 0.35], [1, 2, 0, 0.5], [2, 2, 0, 0.45], [2, 3, 0, 0.35], [3, 2, 0, 0.5]],
                clap: [[1, 0, 0, 0.6], [3, 0, 0, 0.6]]
            },
            {
                label: 'House',
                kick: [[0, 0, 0, 1.0], [1, 0, 0, 1.0], [2, 0, 0, 1.0], [3, 0, 0, 1.0]],
                snare: [[1, 0, 0, 0.8], [3, 0, 0, 0.8]],
                hihat: [[0, 2, 0, 0.4], [1, 2, 0, 0.5], [2, 2, 0, 0.4], [3, 2, 0, 0.5]],
                clap: [[1, 0, 0, 0.6], [3, 0, 0, 0.6]]
            },
            {
                label: 'Techno',
                kick: [[0, 0, 0, 1.0], [1, 0, 0, 1.0], [2, 0, 0, 1.0], [3, 0, 0, 1.0], [1, 2, 0, 0.6], [3, 2, 0, 0.6]],
                snare: [[1, 0, 0, 0.7], [3, 0, 0, 0.7]],
                hihat: [[0, 2, 0, 0.6], [0, 3, 0, 0.4], [1, 2, 0, 0.65], [1, 3, 0, 0.45], [2, 2, 0, 0.6], [2, 3, 0, 0.4], [3, 2, 0, 0.65], [3, 3, 0, 0.45]],
                clap: [[1, 0, 0, 0.5], [3, 0, 0, 0.5]]
            },
            {
                label: 'UK Garage',
                kick: [[0, 0, 0, 1.0], [1, 3, 0, 0.7], [2, 2, 0, 0.9], [3, 3, 0, 0.65]],
                snare: [[1, 0, 0, 0.85], [2, 3, 0, 0.5], [3, 0, 0, 0.85]],
                hihat: [[0, 2, 0, 0.5], [0, 3, 0, 0.3], [1, 1, 0, 0.35], [1, 2, 0, 0.55], [2, 2, 0, 0.5], [3, 1, 0, 0.35], [3, 2, 0, 0.55]],
                clap: [[1, 0, 0, 0.6], [3, 0, 0, 0.6], [2, 2, 2, 0.4]]
            },
            {
                label: 'Drum & Bass',
                kick: [[0, 0, 0, 1.0], [1, 1, 0, 0.8], [2, 2, 0, 0.9], [3, 0, 0, 0.7]],
                snare: [[1, 0, 0, 0.9], [1, 2, 2, 0.5], [2, 3, 0, 0.6], [3, 0, 0, 0.9]],
                hihat: [[0, 2, 0, 0.5], [0, 3, 0, 0.3], [1, 2, 0, 0.6], [1, 3, 0, 0.4], [2, 2, 0, 0.5], [2, 3, 0, 0.3], [3, 2, 0, 0.6], [3, 3, 0, 0.4]],
                clap: []
            },
            {
                label: 'Jungle',
                kick: [[0, 0, 0, 1.0], [1, 2, 0, 0.8], [2, 1, 0, 0.75], [3, 3, 0, 0.85]],
                snare: [[1, 0, 0, 0.9], [2, 2, 0, 0.7], [3, 0, 0, 0.9]],
                hihat: [[0, 2, 0, 0.55], [0, 3, 0, 0.45], [1, 1, 0, 0.35], [1, 2, 0, 0.55], [1, 3, 0, 0.45], [2, 2, 0, 0.55], [2, 3, 0, 0.45], [3, 2, 0, 0.55], [3, 3, 0, 0.45]],
                clap: [[1, 0, 0, 0.5], [3, 0, 0, 0.5]]
            },
            {
                label: 'Rock',
                kick: [[0, 0, 0, 1.0], [2, 0, 0, 1.0]],
                snare: [[1, 0, 0, 1.0], [3, 0, 0, 1.0]],
                hihat: [[0, 2, 0, 0.6], [1, 2, 0, 0.7], [2, 2, 0, 0.6], [3, 2, 0, 0.7]],
                clap: []
            },
            {
                label: 'Pop',
                kick: [[0, 0, 0, 1.0], [1, 2, 0, 0.7], [3, 0, 0, 0.8]],
                snare: [[1, 0, 0, 0.85], [3, 0, 0, 0.85]],
                hihat: [[0, 2, 0, 0.4], [1, 2, 0, 0.45], [2, 2, 0, 0.4], [3, 2, 0, 0.45]],
                clap: [[1, 0, 0, 0.5], [3, 0, 0, 0.5]]
            }
        ];
        const RHYTHM_STYLE_NAMES = RHYTHM_PATTERNS.map(pattern => pattern.label);
        const DEFAULT_DRUM_RHYTHM = 0.5;
        const drumRhythmDisplay = document.getElementById('drumRhythmValue');
        const drumRhythmSlider = document.getElementById('drumRhythm');

        function getRhythmLabel(value) {
            if (!RHYTHM_STYLE_NAMES.length) {
                return `${Math.round(value * 100)}%`;
            }
            const maxIndex = RHYTHM_STYLE_NAMES.length - 1;
            const clampedValue = Math.min(Math.max(value, 0), 1);
            const position = clampedValue * maxIndex;
            const lowerIndex = Math.floor(position);
            const upperIndex = Math.min(maxIndex, lowerIndex + 1);
            const blend = position - lowerIndex;
            const lowerName = RHYTHM_STYLE_NAMES[lowerIndex];
            const upperName = RHYTHM_STYLE_NAMES[upperIndex];
            if (blend < 0.05 || lowerIndex === upperIndex) return lowerName;
            if (blend > 0.95) return upperName;
            return `${lowerName} -> ${upperName} (${Math.round(blend * 100)}%)`;
        }

        function updateRhythmDisplay(value) {
            if (!drumRhythmDisplay) return;
            drumRhythmDisplay.textContent = getRhythmLabel(value);
        }

        if (drumRhythmSlider) {
            updateRhythmDisplay(parseFloat(drumRhythmSlider.value) || DEFAULT_DRUM_RHYTHM);
        } else if (drumRhythmDisplay) {
            updateRhythmDisplay(DEFAULT_DRUM_RHYTHM);
        }
        document.querySelectorAll('[data-drum-filter-bypass]').forEach(button => {
            const drum = button.getAttribute('data-drum-filter-bypass');
            if (!drum) return;
            drumFilterBypassButtons[drum] = button;
            button.addEventListener('click', () => {
                setDrumFilterBypassState(drum, !isDrumFilterBypassed(drum));
            });
        });
        Object.keys(drumFilterBypassStates).forEach(updateDrumFilterBypassButton);

        function wait(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        function getDrumSliderValue(drum) {
            const slider = drumVolumeSliders[drum];
            return slider ? parseFloat(slider.value) : 0;
        }

        function timeStringToSteps(timeStr) {
            const parts = timeStr.split(':').map(num => parseInt(num, 10) || 0);
            const [measure = 0, quarter = 0, sixteenth = 0] = parts;
            return (measure * 16) + (quarter * 4) + sixteenth;
        }

        function stepsToTimeString(steps) {
            const measure = Math.floor(steps / 16);
            const remainder = steps % 16;
            const quarter = Math.floor(remainder / 4);
            const sixteenth = remainder % 4;
            return `${measure}:${quarter}:${sixteenth}`;
        }

        function setDrumMuteState(muted, immediate = false) {
            drumsMuted = Boolean(muted);
            if (!drumBus || drumBus.disposed) return;
            const targetDb = drumsMuted ? SILENCE_DB : DRUM_DEFAULT_DB;
            const now = Tone.now();
            drumBus.volume.cancelScheduledValues(now);
            if (immediate) {
                drumBus.volume.setValueAtTime(targetDb, now);
                return;
            }
            drumBus.volume.setValueAtTime(drumBus.volume.value, now);
            drumBus.volume.linearRampToValueAtTime(targetDb, now + SOUND_FADE_DURATION);
        }

        function isDrumFilterBypassed(drum) {
            return Boolean(drumFilterBypassStates[drum]);
        }

        function updateDrumFilterBypassButton(drum) {
            const button = drumFilterBypassButtons[drum];
            if (!button) return;
            const bypassed = isDrumFilterBypassed(drum);
            button.textContent = bypassed ? 'Bypassed' : 'Filter On';
            button.classList.toggle('is-bypassed', bypassed);
        }

        function setDrumFilterBypassState(drum, bypassed, options = {}) {
            if (!Object.prototype.hasOwnProperty.call(drumFilterBypassStates, drum)) return;
            const normalized = Boolean(bypassed);
            if (drumFilterBypassStates[drum] === normalized) {
                updateDrumFilterBypassButton(drum);
                if (!options.skipStateUpdate) {
                    updateStateDisplay();
                }
                return;
            }
            drumFilterBypassStates[drum] = normalized;
            if (normalized) {
                if (drumFilters[drum] && !drumFilters[drum].disposed) {
                    drumFilters[drum].disconnect();
                    drumFilters[drum].dispose();
                }
                drumFilters[drum] = null;
            } else if (!drumFilters[drum] || drumFilters[drum].disposed) {
                drumFilters[drum] = new Tone.Filter(DRUM_FILTER_SETTINGS[drum]);
                applyDrumFilterTarget(drum);
            }
            updateDrumFilterBypassButton(drum);
            if (!options.skipRouting && isSetup) {
                refreshSingleDrumRouting(drum);
            }
            if (!options.skipStateUpdate) {
                updateStateDisplay();
            }
        }


        let currentLayerTranspose = 0;
        let currentLayerDepth = 0;
        let currentLayerOffsetSeconds = 0;
        let currentGranularWet = 0;
        let currentEchoWet = 0;
        let currentSpreadDetune = 0;
        let currentFundamental = 110;

        function updateDelayWetness(value) {
            const numeric = parseFloat(value);
            currentEchoWet = mapValue(numeric, 0, 8, 0, MAX_DELAY_WET);
            delays.forEach(delay => {
                if (delay && delay.wet) {
                    delay.wet.value = currentEchoWet;
                }
            });
        }

        function applySpreadDetune(value) {
            const clamped = Math.min(5, Math.max(1, parseFloat(value)));
            currentSpreadDetune = mapValue(clamped, 1, 5, -SPREAD_DETUNE_RANGE, SPREAD_DETUNE_RANGE);
            if (synth && !synth.disposed) {
                synth.set({ detune: currentSpreadDetune });
            }
            if (layerSynth && !layerSynth.disposed) {
                layerSynth.set({ detune: currentSpreadDetune });
            }
        }

        function ensureFlutterWowLFO() {
            if (!flutterWowLFO) {
                flutterWowLFO = new Tone.LFO(0.25, 0, 0);
                flutterWowLFO.phase = 90;
                flutterWowLFO.start();
            }
            return flutterWowLFO;
        }

        function connectFlutterWowToVoices() {
            if (!flutterWowLFO) return;
            flutterWowLFO.disconnect();
            const tryConnectDetune = (node) => {
                if (!node || node.disposed) return;
                const detuneSignal = node.detune;
                if (detuneSignal && typeof detuneSignal.connect === 'function') {
                    flutterWowLFO.connect(detuneSignal);
                }
            };
            tryConnectDetune(synth);
            tryConnectDetune(layerSynth);
        }

        function applyFlutterWowSettings(params) {
            if (!params) return;
            const depthAmount = Math.max(0, Math.min(1, params.flutterDepth ?? 0));
            const rateAmount = Math.max(0, Math.min(1, params.flutterRate ?? 0.5));
            if (depthAmount <= 0) {
                if (flutterWowLFO) {
                    flutterWowLFO.disconnect();
                    flutterWowLFO.min = 0;
                    flutterWowLFO.max = 0;
                }
                return;
            }
            const lfo = ensureFlutterWowLFO();
            const mappedDepth = mapValue(depthAmount, 0, 1, 0, FLUTTER_WOW_MAX_DEPTH);
            lfo.min = -mappedDepth;
            lfo.max = mappedDepth;
            lfo.frequency.value = mapValue(rateAmount, 0, 1, FLUTTER_WOW_RATE_RANGE.min, FLUTTER_WOW_RATE_RANGE.max);
            connectFlutterWowToVoices();
        }

        const uiContainer = document.getElementById('ui-container');
        const playPauseButton = document.getElementById('playPauseButton');
        const stopButton = document.getElementById('stopButton');
        const randomizeButton = document.getElementById('randomizeButton');
        const toggleButton = document.getElementById('toggleButton');
        const controlsPanel = document.getElementById('controls-panel');
        const iconMinimize = document.getElementById('icon-minimize');
        const iconMaximize = document.getElementById('icon-maximize');
        const toggleVisualizerButton = document.getElementById('toggleVisualizerButton');
        const toggleStateButton = document.getElementById('toggleStateButton');
        const statePanel = document.getElementById('statePanel');
        const stateInput = document.getElementById('stateInput');
        const copyStateButton = document.getElementById('copyStateButton');
        const pasteStateButton = document.getElementById('pasteStateButton');
        // No manual drum mute toggle; drums start silent via sliders.
        ['kick', 'snare', 'hihat', 'clap'].forEach(drum => {
            updateSlider(`${drum}Volume`, 0, 2);
            const filterId = `${drum}Filter`;
            const chanceId = `${drum}Chance`;
            const defaultFilter = DRUM_FILTER_SETTINGS[drum]?.frequency;
            if (defaultFilter !== undefined) {
                updateSlider(filterId, defaultFilter, 0);
            }
            updateSlider(chanceId, 100, 0);
            updateDrumFilterFrequency(drum);
        });

        // --- TAB SWITCHING ---
        const tabs = document.querySelectorAll('.tab');
        const tabContents = document.querySelectorAll('.tab-content');

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;

                // Update active states
                tabs.forEach(t => t.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));

                tab.classList.add('active');
                document.getElementById(`tab-${targetTab}`).classList.add('active');
            });
        });

        function syncPanelToggleIcons() {
            if (!iconMinimize || !iconMaximize) return;
            const panelHidden = controlsPanel.classList.contains('hidden');
            iconMinimize.classList.toggle('hidden', panelHidden);
            iconMaximize.classList.toggle('hidden', !panelHidden);
        }

        function updateVisualizerToggleButton() {
            if (!toggleVisualizerButton) return;
            toggleVisualizerButton.textContent = isVisualizerFrozen ? '🧊' : '🌌';
            toggleVisualizerButton.title = isVisualizerFrozen ? 'Zet animatie aan' : 'Zet animatie uit';
        }

        function animateControlsPanelGrowth() {
            if (!controlsPanel || typeof controlsPanel.animate !== 'function') {
                return Promise.resolve();
            }
            controlsPanel.style.transformOrigin = 'center';
            const animation = controlsPanel.animate(
                [
                    { transform: 'scale(0.9)', opacity: 0, filter: 'blur(4px)' },
                    { transform: 'scale(1)', opacity: 1, filter: 'blur(0px)' }
                ],
                { duration: 450, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
            );
            return animation.finished.catch(() => {});
        }

        async function setVisualizerFrozen(frozen) {
            const normalized = Boolean(frozen);
            if (isVisualizerFrozen === normalized) return;

            if (normalized) {
                await playBoringSequence();
                if (isVisualizerFrozen === normalized) {
                    return;
                }
            }

            isVisualizerFrozen = normalized;
            document.body.classList.toggle('visualizer-disabled', normalized);
            if (normalized) {
                previousUILayoutState = {
                    isCentered: uiContainer.classList.contains('is-centered'),
                    panelHidden: controlsPanel.classList.contains('hidden')
                };
                pauseVisualizer();
                uiContainer.classList.add('is-centered');
                controlsPanel.classList.remove('hidden');
                syncPanelToggleIcons();
                await animateControlsPanelGrowth();
            } else {
                const state = previousUILayoutState || { isCentered: true, panelHidden: false };
                uiContainer.classList.toggle('is-centered', state.isCentered);
                controlsPanel.classList.toggle('hidden', state.panelHidden);
                syncPanelToggleIcons();
                previousUILayoutState = null;
                if (!document.hidden) {
                    resumeVisualizer();
                }
            }
            updateVisualizerToggleButton();
        }

        // --- UI TOGGLE LOGIC ---
        toggleButton.addEventListener('click', (e) => {
            e.stopPropagation();
            controlsPanel.classList.toggle('hidden');
            syncPanelToggleIcons();
        });

        if (toggleVisualizerButton) {
            toggleVisualizerButton.addEventListener('click', (e) => {
                e.stopPropagation();
                setVisualizerFrozen(!isVisualizerFrozen);
            });
        }

        toggleStateButton.addEventListener('click', (e) => {
            e.stopPropagation();
            statePanel.classList.toggle('hidden');
        });

        window.addEventListener('click', (event) => {
            const isPanelOpen = !controlsPanel.classList.contains('hidden');
            const isUICornered = !uiContainer.classList.contains('is-centered');

            if (isPanelOpen && isUICornered) {
                if (!controlsPanel.contains(event.target) && !toggleButton.contains(event.target)) {
                    controlsPanel.classList.add('hidden');
                    syncPanelToggleIcons();
                }
            }
        });

        updateVisualizerToggleButton();
        syncPanelToggleIcons();


        // --- Hoofdfuncties ---
        async function setupAndPlay() {
            if (Tone.context.state !== 'running') {
                await Tone.start();
            }
            
            await generateSoundscape();
            Tone.Transport.start();
            isSetup = true;
            playPauseButton.textContent = 'Pause';
        }

        function cleanupAudio(fullCleanup = false) {
            if (notePart) {
                notePart.stop(0).dispose();
                notePart = null;
            }

            if (granularPart) {
                granularPart.stop(0).dispose();
                granularPart = null;
            }

            if (drumPart) {
                drumPart.stop(0).dispose();
                drumPart = null;
            }

            if (synth) {
                synth.releaseAll();
                synth.disconnect();
                if (fullCleanup) {
                    synth.dispose();
                    synth = null;
                }
            }

            if (layerSynth) {
                layerSynth.releaseAll();
                layerSynth.disconnect();
                if (fullCleanup) {
                    layerSynth.dispose();
                    layerSynth = null;
                }
            }

            [kickDrum, snareDrum, hihatDrum, clapDrum].forEach(drum => {
                if (drum) {
                    drum.disconnect();
                    if (fullCleanup) {
                        drum.dispose();
                    }
                }
            });
            if (fullCleanup) {
                kickDrum = null;
                snareDrum = null;
                hihatDrum = null;
                clapDrum = null;
            }

            [...delays, reverb, masterVolume, layerVolume, layerFilter, synthFilter, synthFilterDryGain, synthFilterWetGain, synthFilterBlendBus, drumBus, kickVolume, snareVolume, hihatVolume, clapVolume, lowTap].forEach(node => {
                if (node && !node.disposed) {
                    node.disconnect();
                    node.dispose();
                }
            });
            disposeDrumFilters();
            delays = [];
            reverb = null;
            masterVolume = null;
            layerVolume = null;
            layerFilter = null;
            synthFilter = null;
            synthFilterIsSVF = false;
            synthFilterDryGain = null;
            synthFilterWetGain = null;
            synthFilterBlendBus = null;
            drumBus = null;
            drumLastTrigger = { kick: 0, snare: 0, hihat: 0, clap: 0 };
            kickVolume = null;
            snareVolume = null;
            hihatVolume = null;
            clapVolume = null;
            if (typeof window !== 'undefined') {
                window.lowTapNode = null;
            }
            lowTap = null;
            if (flutterWowLFO) {
                flutterWowLFO.disconnect();
            }
        }

        let automationLoopEvent = null;

        function triggerLayeredClap(time, velocity) {
            if (velocity <= 0 || !clapDrum || clapDrum.disposed) return;
            const boostedVelocity = Math.min(1, velocity * 1.25);
            safeTriggerAttackRelease(clapDrum, 'clap', null, '16n', time, boostedVelocity);
            safeTriggerAttackRelease(clapDrum, 'clap', null, '16n', time + CLAP_FLAM_OFFSET, boostedVelocity * 0.8);
        }

        function updateDrumPart(params) {
            if (!params) return;
            if (drumPart) {
                drumPart.stop(0).dispose();
                drumPart = null;
            }
            const drumPattern = generateDrumPattern(params);
            const feelAmount = params.drumFeel || 0;
            drumPart = new Tone.Part((time, value) => {
                if (Tone.Transport.state !== 'started') return;
                const sliderLevel = Math.max(0, getDrumSliderValue(value.drum));
                if (sliderLevel <= 0) return;
                let hitVelocity = Math.min(1, value.velocity * sliderLevel);

                if (feelAmount > 0) {
                    const accentRange = feelAmount * 0.65;
                    // Use time-based variation instead of Random for consistency
                    const timeHash = ((time * 1000) % 100) / 100;
                    const accentVariance = (timeHash - 0.5) * accentRange * 0.8;
                    hitVelocity = Math.min(1, Math.max(0.05, hitVelocity * (1 + accentVariance)));

                    const ghostChance = feelAmount * 0.25;
                    const ghostHash = ((time * 731) % 100) / 100;
                    if (ghostHash < ghostChance) {
                        const ghostAmount = 0.5 + ((time * 523) % 30) / 100;
                        hitVelocity *= ghostAmount;
                    }
                }

                const hitChance = getDrumChanceValue(value.drum);
                if (hitChance < 1 && Random.float(0, 1) > hitChance) {
                    return;
                }

                switch(value.drum) {
                    case 'kick':
                        if (kickDrum && !kickDrum.disposed) {
                            safeTriggerAttackRelease(kickDrum, 'kick', 'C1', '8n', time, hitVelocity);
                            triggerDrumVisual('kick', hitVelocity);
                        }
                        break;
                    case 'snare':
                        if (snareDrum && !snareDrum.disposed) {
                            safeTriggerAttackRelease(snareDrum, 'snare', null, '8n', time, hitVelocity);
                            triggerDrumVisual('snare', hitVelocity);
                        }
                        break;
                    case 'hihat':
                        if (hihatDrum && !hihatDrum.disposed) {
                            safeTriggerAttackRelease(hihatDrum, 'hihat', null, '32n', time, hitVelocity);
                            triggerDrumVisual('hihat', hitVelocity);
                        }
                        break;
                    case 'clap':
                        if (clapDrum && !clapDrum.disposed) {
                            triggerLayeredClap(time, hitVelocity);
                            triggerDrumVisual('clap', hitVelocity);
                        }
                        break;
                }
            }, drumPattern).start(0);

            drumPart.loop = true;
            drumPart.loopEnd = `${params.patternLength}m`;
            drumPart.humanize = feelAmount > 0 ? feelAmount * MAX_HUMANIZE_TIME : false;
        }

        // --- Drum Pattern Generation ---
        function addRandomRepeats(pattern, params) {
            if (!pattern || pattern.length === 0) return pattern;
            const totalSteps = Math.max(16, params.patternLength * 16);
            const configs = [
                { drum: 'kick', amount: params.kickRepeat, spread: 2 },
                { drum: 'snare', amount: params.snareRepeat, spread: 3 },
                { drum: 'hihat', amount: params.hihatRepeat, spread: 1 },
                { drum: 'clap', amount: params.clapRepeat, spread: 2 }
            ];
            const augmented = [...pattern];

            configs.forEach(({ drum, amount, spread }, configIdx) => {
                if (!amount || amount <= 0) return;
                const baseHits = pattern.filter(hit => hit.drum === drum);
                const repeatsPerHit = Math.max(1, Math.round(mapValue(amount, 0, 1, 0, 3)));
                baseHits.forEach((hit, hitIdx) => {
                    const baseSteps = timeStringToSteps(hit.time);
                    for (let i = 0; i < repeatsPerHit; i++) {
                        // Deterministic threshold based on amount and indices
                        const threshold = ((configIdx + hitIdx + i) % 10) / 10;
                        if (threshold > amount) continue;
                        // Deterministic direction based on index
                        const direction = ((hitIdx + i) % 2 === 0) ? 1 : -1;
                        // Deterministic offset based on indices
                        const offset = 1 + ((configIdx + hitIdx + i) % spread);
                        let newSteps = baseSteps + direction * offset;
                        if (newSteps < 0) newSteps += totalSteps;
                        if (newSteps >= totalSteps) newSteps -= totalSteps;
                        augmented.push({
                            time: stepsToTimeString(newSteps),
                            drum,
                            velocity: Math.min(1, hit.velocity * mapValue(amount, 0, 1, 0.4, 0.95))
                        });
                    }
                });
            });

            return augmented;
        }

        function generateDrumPattern(params) {
            const rhythmPatterns = RHYTHM_PATTERNS;
            // Interpolate between patterns based on rhythm value
            const rhythmValue = params.drumRhythm;
            const patternCount = rhythmPatterns.length;
            const position = rhythmValue * (patternCount - 1);
            const lowerIndex = Math.floor(position);
            const upperIndex = Math.min(lowerIndex + 1, patternCount - 1);
            const blend = position - lowerIndex;

            const lowerPattern = rhythmPatterns[lowerIndex];
            const upperPattern = rhythmPatterns[upperIndex];

            // Blend patterns
            const blendedPattern = [];

            // Helper function to blend two hit arrays
            const blendHits = (lower, upper, drumType) => {
                const allHits = new Map();

                // Add lower pattern hits
                lower.forEach(hit => {
                    const key = `${hit[0]}:${hit[1]}:${hit[2]}`;
                    allHits.set(key, {
                        quarter: hit[0],
                        sixteenth: hit[1],
                        offset: hit[2],
                        velocity: hit[3] * (1 - blend),
                        drum: drumType
                    });
                });

                // Add or blend upper pattern hits
                upper.forEach(hit => {
                    const key = `${hit[0]}:${hit[1]}:${hit[2]}`;
                    if (allHits.has(key)) {
                        allHits.get(key).velocity += hit[3] * blend;
                    } else if (blend > 0.5) { // Only add new upper hits if blend is > 0.5
                        allHits.set(key, {
                            quarter: hit[0],
                            sixteenth: hit[1],
                            offset: hit[2],
                            velocity: hit[3] * blend,
                            drum: drumType
                        });
                    }
                });

                return Array.from(allHits.values());
            };

            // Blend all drum types
            const kickHits = blendHits(lowerPattern.kick, upperPattern.kick, 'kick');
            const snareHits = blendHits(lowerPattern.snare, upperPattern.snare, 'snare');
            const hihatHits = blendHits(lowerPattern.hihat, upperPattern.hihat, 'hihat');
            const clapHits = blendHits(lowerPattern.clap, upperPattern.clap, 'clap');

            // Convert to Tone.js format and repeat for pattern length
            for (let measure = 0; measure < params.patternLength; measure++) {
                [...kickHits, ...snareHits, ...hihatHits, ...clapHits].forEach(hit => {
                    blendedPattern.push({
                        time: `${measure}:${hit.quarter}:${hit.sixteenth}`,
                        drum: hit.drum,
                        velocity: Math.min(1.0, hit.velocity)
                    });
                });
            }

            const hiHatExtras = [];
            const hiHatDensity = mapValue(params.drumRhythm, 0, 1, 0.4, 0.85);
            const hiHatVelocity = mapValue(params.drumRhythm, 0, 1, 0.35, 0.75);
            // Deterministic hi-hat pattern based on rhythm value
            const hiHatSteps = Math.floor(hiHatDensity * params.patternLength * 4);
            for (let i = 0; i < hiHatSteps; i++) {
                const totalSteps = params.patternLength * 4;
                const step = Math.floor((i * totalSteps) / hiHatSteps);
                const measure = Math.floor(step / 4);
                const quarter = step % 4;
                const sixteenth = (i % 2) + 1; // Alternate between 1 and 2
                const velocityVar = 0.15 * Math.sin(i * 2.5); // Subtle variation
                hiHatExtras.push({
                    time: `${measure}:${quarter}:${sixteenth}`,
                    drum: 'hihat',
                    velocity: hiHatVelocity + velocityVar * hiHatVelocity
                });
            }

            const clapExtras = [];
            const clapDensity = mapValue(params.drumRhythm, 0, 1, 0.25, 0.65);
            // Deterministic clap pattern based on rhythm value
            const clapCount = Math.floor(clapDensity * params.patternLength * 1.5);
            for (let i = 0; i < clapCount; i++) {
                const measure = Math.floor((i * params.patternLength) / Math.max(1, clapCount));
                const quarter = (i % 3) + 1; // Distribute across beats
                const sixteenth = (i % 2) * 2; // 0 or 2
                const velocityBase = 0.35 + (0.4 * clapDensity);
                const velocityVar = 0.1 * Math.sin(i * 3.7);
                clapExtras.push({
                    time: `${measure}:${quarter}:${sixteenth}`,
                    drum: 'clap',
                    velocity: velocityBase + velocityVar
                });
            }

            const basePattern = [...blendedPattern, ...hiHatExtras, ...clapExtras];
            return addRandomRepeats(basePattern, params);
        }

        async function generateSoundscape(options = {}) {
            const { skipFade = false } = options || {};
            const params = getUIParams();
            const patternParams = { ...params, patternLength: PATTERN_STRUCTURE_MEASURES };
            setSynthFilterMixAmount(params.synthFilterMix ?? SYNTH_FILTER_MIX_DEFAULT);

            if (!skipFade && isSetup && masterVolume && !masterVolume.disposed) {
                const now = Tone.now();
                masterVolume.volume.cancelScheduledValues(now);
                masterVolume.volume.setValueAtTime(masterVolume.volume.value, now);
                masterVolume.volume.linearRampToValueAtTime(SILENCE_DB, now + SOUND_FADE_DURATION);
                await wait(SOUND_FADE_DURATION * 1000);
            }

            if (isSetup) {
                 cleanupAudio(false);
            }

            loopCounter = 0; // Reset loop counter when regenerating
            scaleCyclePosition = 0;
            currentLayerTranspose = params.laag;
            currentLayerDepth = params.gelaagdheid;
            currentLayerOffsetSeconds = mapValue(params.layerOffset, 0, 1, 0, 0.6);
            currentGranularWet = params.granular;
            currentFundamental = params.fundamental;
            resetSimpleStartColors();

            recalcBaseHueFromParams(params);

            const mainEnvelope = buildMainSynthEnvelope(params);
            const layerEnvelope = buildLayerSynthEnvelope(params);

            if (!synth || synth.disposed) {
                 synth = new Tone.PolySynth(Tone.FMSynth).toDestination();
            }

            if (!layerSynth || layerSynth.disposed) {
                 // Create 101-style square wave synth
                    layerSynth = new Tone.PolySynth(Tone.MonoSynth, {
                    oscillator: { type: 'square' },
                    envelope: layerEnvelope
                 }).toDestination();
            }

            if (!kickDrum || kickDrum.disposed) {
                // Create 909-style kick drum
                kickDrum = new Tone.MembraneSynth({
                    pitchDecay: 0.05,
                    octaves: 10,
                    oscillator: { type: 'sine' },
                    envelope: {
                        attack: 0.001,
                        decay: 0.4,
                        sustain: 0.01,
                        release: 1.4,
                        attackCurve: 'exponential'
                    }
                }).toDestination();
            }

            if (!snareDrum || snareDrum.disposed) {
                // Create 909-style snare drum
                snareDrum = new Tone.NoiseSynth({
                    noise: { type: 'white' },
                    envelope: {
                        attack: 0.001,
                        decay: 0.2,
                        sustain: 0.0,
                        release: 0.2
                    }
                }).toDestination();
            }

            if (!hihatDrum || hihatDrum.disposed) {
                // Softer noise-based hi-hat
                hihatDrum = new Tone.NoiseSynth({
                    noise: { type: 'white' },
                    envelope: {
                        attack: 0.001,
                        decay: 0.11,
                        sustain: 0,
                        release: 0.05
                    }
                }).toDestination();
            }

            if (!clapDrum || clapDrum.disposed) {
                // Distinct clap with a longer, filtered tail
                clapDrum = new Tone.NoiseSynth({
                    noise: { type: 'pink' },
                    envelope: {
                        attack: 0.001,
                        decay: 0.25,
                        sustain: 0,
                        release: 0.25,
                        attackCurve: 'linear'
                    }
                }).toDestination();
            }

            const harmonicity = mapValue(params.fmTimbre, 0, 20, 1, 4);
            const modulationIndex = mapValue(params.fmTimbre, 0, 20, 0, 20);

            synth.set({
                harmonicity,
                modulationIndex,
                envelope: mainEnvelope,
                modulationEnvelope: {
                    attack: 0.01,
                    decay: params.fmModDepth,
                    sustain: 1,
                    release: 0.5
                }
            });

            // Update layer synth envelope based on main synth params
            updateLayerSynthEnvelope(params);
            applySpreadDetune(params.noteSpread);
            applyFlutterWowSettings(params);

            reverb = new Tone.Reverb({ decay: 8, preDelay: 0.01, wet: params.reverbWet }).toDestination();
            delays = Array.from({ length: Math.max(0, Math.round(params.nDelayChains)) }, () =>
                new Tone.FeedbackDelay({
                    delayTime: Random.select(["8n", "4n.", "4n"]),
                    feedback: Random.float(0.2, 0.5),
                    wet: Random.float(0.2, 0.45)
                }).connect(reverb)
            );
            updateDelayWetness(params.nDelayChains);
            masterVolume = new Tone.Volume(DEFAULT_MASTER_DB);
            masterVolume.volume.value = SILENCE_DB;
            masterVolume.volume.linearRampToValueAtTime(DEFAULT_MASTER_DB, Tone.now() + SOUND_FADE_DURATION);

            drumBus = new Tone.Volume(DEFAULT_MASTER_DB).toDestination();
            lowTap = new Tone.Gain(1);
            if (typeof window !== 'undefined') {
                window.lowTapNode = lowTap;
            }
            setDrumMuteState(drumsMuted, true);

            // Layer filter and depth (simple low-pass for the layer voice)
            const layerFilterFreq = mapLayerFilterValue(params.layerFilter);
            layerFilter = new Tone.Filter(layerFilterFreq, 'lowpass', -24);
            layerVolume = new Tone.Volume(mapValue(params.gelaagdheid, 0, 1, -72, -18));
            applyLayerLowpassCenter(layerFilterFreq);

            // Synth filter (Three Sisters SVF) for the main klank path
            const synthFilterFrequency = Math.min(Math.max(params.synthFilterFrequency, SYNTH_FILTER_FREQUENCY_MIN), SYNTH_FILTER_FREQUENCY_MAX);
            const synthFilterSpan = clampSynthFilterSpan(params.synthFilterSpan);
            const synthFilterQ = Math.min(Math.max(params.synthFilterQ ?? SYNTH_FILTER_DEFAULT_Q, SYNTH_FILTER_Q_MIN), SYNTH_FILTER_Q_MAX);
            let filterNode = null;
            synthFilterIsSVF = false;
            const supportsSVF = canUseThreeSistersSVF();
            if (supportsSVF) {
                try {
                    filterNode = new ThreeSistersSVF({
                        center: synthFilterFrequency,
                        span: synthFilterSpan,
                        q: synthFilterQ,
                        feedback: SYNTH_FILTER_DEFAULT_FEEDBACK
                    });
                    await filterNode.ready();
                    synthFilterIsSVF = true;
                } catch (error) {
                    console.warn('ThreeSistersSVF init failed, falling back to simple filter:', error && error.message ? error.message : error);
                    if (filterNode) {
                        filterNode.dispose();
                        filterNode = null;
                    }
                    synthFilterIsSVF = false;
                }
            }
            if (!filterNode) {
                filterNode = new SimpleThreeBandFilter({
                    center: synthFilterFrequency,
                    span: synthFilterSpan,
                    q: synthFilterQ
                });
                synthFilterIsSVF = false;
            }
            synthFilter = filterNode;
            applySynthFilterSettings({ frequency: synthFilterFrequency, span: synthFilterSpan, q: synthFilterQ });

            // Drum volume controls
            kickVolume = new Tone.Volume(mapValue(params.kickVol, 0, 1, KICK_VOLUME_DB_RANGE.min, KICK_VOLUME_DB_RANGE.max));
            snareVolume = new Tone.Volume(mapValue(params.snareVol, 0, 1, DRUM_VOLUME_DB_RANGE.min, DRUM_VOLUME_DB_RANGE.max));
            hihatVolume = new Tone.Volume(mapValue(params.hihatVol, 0, 1, HIHAT_DB_RANGE.min, HIHAT_DB_RANGE.max));
            clapVolume = new Tone.Volume(mapValue(params.clapVol, 0, 1, CLAP_DB_RANGE.min, CLAP_DB_RANGE.max));
            createDrumFilters();

            synth.connect(masterVolume);
            refreshSynthRouting();

            layerSynth.connect(layerFilter);
            layerFilter.connect(layerVolume);
            layerVolume.connect(reverb);
            delays.forEach(delay => layerVolume.connect(delay));
            if (lowTap) {
                layerVolume.connect(lowTap);
            }

            // Connect drums to their dedicated filters and bus
            wireDrumRouting();

            currentPatternStructure = generatePatternStructure(patternParams);
            const melodicEvents = renderPatternStructure(currentPatternStructure, patternParams);
            patternPlaybackLength = Math.max(1, Math.min(PATTERN_STRUCTURE_MEASURES, params.patternLength));
            if (notePart) {
                notePart.stop(0).dispose();
                notePart = null;
            }
            notePart = createMelodicPart(melodicEvents, params);

            const grainNotes = generateGranularNotes(patternParams);
            rebuildGranularPart(patternParams, grainNotes);

            // Create drum patterns based on rhythm slider
            updateDrumPart(patternParams);

            updatePatternPlaybackLength(params.patternLength);

            Tone.Transport.bpm.value = params.bpm;
        }

        // --- Pattern Generation ---
        function beatToTimeString(beat) {
            const measure = Math.floor(beat / 4);
            const quarter = Math.floor(beat % 4);
            const sixteenth = Math.floor((beat * 4) % 4);
            return `${measure}:${quarter}:${sixteenth}`;
        }

        function generatePatternStructure(params) {
            const structure = [];
            const rhythmicMotifs = [[0.5, 0.25, 0.25], [0.25, 0.25, 0.5], [1], [0.5, 0.5], [0.25, 0.75]];
            const totalBeats = PATTERN_STRUCTURE_MEASURES * 4;
            const degreeRange = {
                min: -Math.max(1, params.noteSpread) * 3,
                max: Math.max(4, params.noteSpread * 4)
            };
            let currentBeat = 0;

            const pickDegree = () => Random.int(degreeRange.min, degreeRange.max);

            while (currentBeat < totalBeats) {
                const motif = Random.select(rhythmicMotifs);
                for (const durationInBeats of motif) {
                    if (currentBeat >= totalBeats) break;
                    if (!Random.coinToss(0.65)) {
                        currentBeat += durationInBeats;
                        continue;
                    }

                    const noteTime = beatToTimeString(currentBeat);
                    if (Random.coinToss(0.15)) {
                        const chordRoot = pickDegree();
                        const chordSize = Random.int(2, 3);
                        const chordDegrees = [];
                        for (let j = 0; j < chordSize; j++) {
                            chordDegrees.push(chordRoot + j * 2);
                        }
                        structure.push({
                            time: noteTime,
                            duration: '16n',
                            velocity: Random.float(0.1, 0.45),
                            degrees: chordDegrees
                        });
                    } else {
                        structure.push({
                            time: noteTime,
                            duration: Random.select(['8n', '4n']),
                            velocity: Random.float(0.2, 0.7),
                            degrees: [pickDegree()]
                        });
                    }
                    currentBeat += durationInBeats;
                }
            }
            return structure;
        }

        function renderPatternStructure(structure, params) {
            if (!structure || !structure.length) return [];
            const scaleSemitones = params.scaleDefinition.semitones;
            const events = [];
            structure.forEach(event => {
                const degrees = event.degrees || [];
                degrees.forEach(degree => {
                    events.push({
                        time: event.time,
                        duration: event.duration,
                        velocity: event.velocity,
                        semitoneOffset: degreeToSemitone(degree, scaleSemitones)
                    });
                });
            });
            return events;
        }

        function createMelodicPart(events, params) {
            if (!events || !events.length) return null;
            const part = new Tone.Part((time, value) => {
                if (Tone.Transport.state !== 'started') return;

                const noteDuration = value.duration || '8n';
                const fundamental = Math.max(10, currentFundamental);
                const semitoneOffset = value.semitoneOffset || 0;
                const finalNote = fundamental * Math.pow(2, semitoneOffset / 12);

                if (synth && !synth.disposed) {
                    synth.triggerAttackRelease(finalNote, noteDuration, time, value.velocity);
                    triggerGridPattern(value.velocity, false, false, 0);
                }

                if (currentLayerDepth > 0 && layerSynth && !layerSynth.disposed) {
                    const transposeMultiplier = Math.pow(2, currentLayerTranspose / 12);
                    const offsetTime = time + currentLayerOffsetSeconds;
                    layerSynth.triggerAttackRelease(finalNote * transposeMultiplier, noteDuration, offsetTime, value.velocity * currentLayerDepth);
                    triggerGridPattern(value.velocity * currentLayerDepth, false, true, currentLayerTranspose);
                }
            }, events).start(0);

            part.loop = true;
            part.loopEnd = `${patternPlaybackLength}m`;
            return part;
        }

        function rebuildMelodicPart(params = null) {
            if (!isSetup || !currentPatternStructure) return;
            const activeParams = params || getUIParams();
            const events = renderPatternStructure(currentPatternStructure, activeParams);
            if (notePart) {
                notePart.stop(0).dispose();
                notePart = null;
            }
            notePart = createMelodicPart(events, activeParams);
        }

        function recalcBaseHueFromParams(params) {
            const fundamentalHue = mapValue(params.fundamentalMidi, 36, 84, 30, 330);
            const timbreShift = mapValue(params.fmTimbre, 0, 20, 0, 120);
            const scaleHue = mapValue(params.scaleIndex, 0, SCALE_DEFINITIONS.length - 1, 0, 360);
            currentBaseHue = (fundamentalHue + timbreShift + scaleHue) % 360;
        }

        function handleFundamentalChange() {
            const params = getUIParams();
            currentFundamental = params.fundamental;
            recalcBaseHueFromParams(params);
        }

        function handleScaleChange() {
            const params = getUIParams();
            recalcBaseHueFromParams(params);
            if (currentPatternStructure) {
                rebuildMelodicPart(params);
            }
            refreshGranularLayerFromUI();
        }

        function scheduleLoopAutomation(patternLength) {
            if (automationLoopEvent !== null) {
                Tone.Transport.clear(automationLoopEvent);
            }
            const loopDuration = `${patternLength}m`;
            automationLoopEvent = Tone.Transport.scheduleRepeat((time) => {
                loopCounter++;

                const automationTiming = parseInt(document.getElementById('automationTiming').value);
                if (automationTiming > 0 && loopCounter % automationTiming === 0) {
                    Tone.Draw.schedule(() => {
                        automateParameter();
                    }, time);
                }
                Tone.Draw.schedule(() => {
                    handleScaleCycle(loopCounter);
                }, time);
            }, loopDuration, loopDuration);
        }

        function updatePatternPlaybackLength(length) {
            const clamped = Math.max(1, Math.min(PATTERN_STRUCTURE_MEASURES, parseInt(length, 10) || 1));
            patternPlaybackLength = clamped;
            if (!notePart && !granularPart && !drumPart) return;
            if (notePart) {
                notePart.loopEnd = `${clamped}m`;
            }
            if (granularPart) {
                granularPart.loopEnd = `${clamped}m`;
            }
            if (drumPart) {
                drumPart.loopEnd = `${clamped}m`;
            }
            loopCounter = 0;
            scaleCyclePosition = 0;
            scheduleLoopAutomation(clamped);
        }

        function collectScaleCycleSteps() {
            return [
                document.getElementById('scaleCycleStep1').value,
                document.getElementById('scaleCycleStep2').value,
                document.getElementById('scaleCycleStep3').value,
                document.getElementById('scaleCycleStep4').value
            ].filter(step => NOTE_NAMES.includes(step));
        }

        function applyScaleCycleStep(note) {
            if (!note) return;
            const noteSelect = document.getElementById('fundamentalNote');
            if (!noteSelect) return;
            noteSelect.value = note;
            refreshSliderDisplay('fundamentalNote');
            handleFundamentalChange();
            updateStateDisplay();
        }

        function handleScaleCycle(currentLoop) {
            if (!isSetup) return;
            const interval = parseInt(document.getElementById('scaleCycleInterval').value);
            if (!interval || interval <= 0) return;
            if (currentLoop % interval !== 0) return;
            const steps = collectScaleCycleSteps();
            if (!steps.length) return;
            const stepIndex = scaleCyclePosition % steps.length;
            const note = steps[stepIndex];
            scaleCyclePosition = (scaleCyclePosition + 1) % steps.length;
            applyScaleCycleStep(note);
        }

        function generateGranularNotes(params) {
            // Derive granular behavior from mix + texture controls
            const texture = Math.max(0, Math.min(1, params.granularTexture ?? 0.5));
            const grainDensity = Math.max(params.granular, 0.2);
            const grainSize = mapValue(texture, 0, 1, 0.18, 0.015); // Higher texture = shorter grains
            const grainSpray = mapValue(texture, 0, 1, 0.02, 0.45);

            const grainNotes = [];
            const totalBeats = params.patternLength * 4;
            const scaleSemitones = params.scaleDefinition.semitones;
            const scaleRatios = scaleSemitones.map(semi => Math.pow(2, semi / 12));
            const octaveChoices = {
                1: [1],
                2: [0.5, 1],
                3: [0.5, 1, 2],
                4: [0.25, 0.5, 1, 2],
                5: [0.25, 0.5, 1, 2, 4]
            };
            const octaves = octaveChoices[params.noteSpread];

            // Calculate number of grains based on density
            const baseGrainCount = totalBeats * 2 * grainDensity;
            const numGrains = Math.max(MIN_GRAIN_COUNT, Math.min(Math.floor(baseGrainCount), MAX_GRAIN_COUNT));

            for (let i = 0; i < numGrains; i++) {
                // Random position within the pattern
                let beat = Random.float(0, totalBeats);

                // Apply spray (randomization)
                beat += Random.float(-grainSpray * 0.5, grainSpray * 0.5);
                beat = Math.max(0, Math.min(totalBeats - 0.01, beat));

                const measure = Math.floor(beat / 4);
                const quarter = Math.floor(beat % 4);
                const sixteenth = Math.floor((beat * 4) % 4);
                const noteTime = `${measure}:${quarter}:${sixteenth}`;

                // Grain pitch with spray variation
                const baseRatio = Random.select(scaleRatios);
                const octave = Random.select(octaves);
                const pitchSpray = grainSpray * Random.float(-0.05, 0.05);
                const ratio = baseRatio * octave * (1 + pitchSpray);

                grainNotes.push({
                    time: noteTime,
                    ratio,
                    duration: `${grainSize}n`,
                    velocity: Random.float(0.05, 0.15), // Quieter grains
                    isGrain: true
                });
            }

            return grainNotes;
        }

        function rebuildGranularPart(params, providedNotes = null) {
            const sourceParams = params
                ? { ...params, patternLength: PATTERN_STRUCTURE_MEASURES }
                : { ...getUIParams(), patternLength: PATTERN_STRUCTURE_MEASURES };
            if (granularPart) {
                granularPart.stop(0).dispose();
                granularPart = null;
            }

            const grainNotes = providedNotes || generateGranularNotes(sourceParams);
            if (!grainNotes || !grainNotes.length) return;

            granularPart = new Tone.Part((time, value) => {
                if (Tone.Transport.state !== 'started' || currentGranularWet <= 0) return;
                const noteDuration = value.duration || '16n';
                const fundamental = Math.max(10, currentFundamental);
                const ratio = value.ratio ?? 1;
                const finalNote = ratio * fundamental;
                const wetVelocity = (value.velocity || 0.1) * currentGranularWet;

                if (synth && !synth.disposed && wetVelocity > 0) {
                    synth.triggerAttackRelease(finalNote, noteDuration, time, wetVelocity);
                    triggerGridPattern(wetVelocity, true, false, 0);
                }
            }, grainNotes).start(0);

            granularPart.loop = true;
            granularPart.loopEnd = `${patternPlaybackLength}m`;
        }

        function refreshGranularLayerFromUI() {
            if (!isSetup) return;
            const params = getUIParams();
            rebuildGranularPart(params);
        }

        function getUIParams() {
            const fundamentalNote = document.getElementById('fundamentalNote').value;
            const fundamentalOctave = parseInt(document.getElementById('fundamentalOctave').value);
            const scaleIndex = clampScaleIndex(parseInt(document.getElementById('gevoel').value));
            const scaleCycleSteps = [
                document.getElementById('scaleCycleStep1').value,
                document.getElementById('scaleCycleStep2').value,
                document.getElementById('scaleCycleStep3').value,
                document.getElementById('scaleCycleStep4').value
            ];

            return {
                fmTimbre: parseFloat(document.getElementById('fmTimbre').value),
                fmModDepth: parseFloat(document.getElementById('fmModDepth').value),
                attackTime: parseFloat(document.getElementById('attackTime').value),
                decayTime: parseFloat(document.getElementById('decayTime').value),
                sustainLevel: parseFloat(document.getElementById('sustainLevel').value),
                releaseTime: parseFloat(document.getElementById('releaseTime').value),
                laag: parseInt(document.getElementById('laag').value),
                gelaagdheid: parseFloat(document.getElementById('gelaagdheid').value),
                layerFilter: parseFloat(document.getElementById('layerFilterControl').value),
                layerOffset: parseFloat(document.getElementById('layerOffset').value),
                layerAttack: parseFloat(document.getElementById('layerAttack').value),
                layerDecay: parseFloat(document.getElementById('layerDecay').value),
                layerSustain: parseFloat(document.getElementById('layerSustain').value),
                layerRelease: parseFloat(document.getElementById('layerRelease').value),
                synthFilterFrequency: parseFloat(document.getElementById('synthFilterFrequency').value),
                synthFilterSpan: parseFloat(document.getElementById('synthFilterSpan').value),
                synthFilterQ: parseFloat(document.getElementById('synthFilterQ').value),
                synthFilterMix: parseFloat(document.getElementById('synthFilterMix').value) / 100,
                fundamentalNote,
                fundamentalOctave,
                fundamental: noteToFrequency(fundamentalNote, fundamentalOctave),
                fundamentalMidi: noteNameToMidi(fundamentalNote, fundamentalOctave),
                scaleIndex,
                scaleDefinition: getScaleDefinition(scaleIndex),
                gevoel: scaleIndex,
                noteSpread: parseInt(document.getElementById('noteSpread').value),
                patternLength: parseInt(document.getElementById('patternLength').value),
                nDelayChains: parseInt(document.getElementById('nDelayChains').value),
                bpm: parseInt(document.getElementById('bpm').value),
                reverbWet: parseFloat(document.getElementById('reverb').value),
                granular: parseFloat(document.getElementById('granular').value),
                granularTexture: parseFloat(document.getElementById('granularTexture').value),
                automation: parseFloat(document.getElementById('automation').value),
                automationTiming: parseInt(document.getElementById('automationTiming').value),
                automationSpeed: parseFloat(document.getElementById('automationSpeed').value),
                scaleCycleInterval: parseInt(document.getElementById('scaleCycleInterval').value),
                scaleCycleSteps,
                flutterDepth: parseFloat(document.getElementById('flutterDepth').value),
                flutterRate: parseFloat(document.getElementById('flutterRate').value),
                drumRhythm: drumRhythmSlider ? parseFloat(drumRhythmSlider.value) : DEFAULT_DRUM_RHYTHM,
                kickVol: parseFloat(document.getElementById('kickVolume').value),
                snareVol: parseFloat(document.getElementById('snareVolume').value),
                hihatVol: parseFloat(document.getElementById('hihatVolume').value),
                clapVol: parseFloat(document.getElementById('clapVolume').value),
                kickFilter: parseFloat(document.getElementById('kickFilter').value),
                snareFilter: parseFloat(document.getElementById('snareFilter').value),
                hihatFilter: parseFloat(document.getElementById('hihatFilter').value),
                clapFilter: parseFloat(document.getElementById('clapFilter').value),
                kickChance: parseFloat(document.getElementById('kickChance').value) / 100,
                snareChance: parseFloat(document.getElementById('snareChance').value) / 100,
                hihatChance: parseFloat(document.getElementById('hihatChance').value) / 100,
                clapChance: parseFloat(document.getElementById('clapChance').value) / 100,
                kickRepeat: parseFloat(document.getElementById('kickRepeat').value),
                snareRepeat: parseFloat(document.getElementById('snareRepeat').value),
                hihatRepeat: parseFloat(document.getElementById('hihatRepeat').value),
                clapRepeat: parseFloat(document.getElementById('clapRepeat').value)
            };
        }

        function buildMainSynthEnvelope(params) {
            return {
                attack: params.attackTime,
                decay: params.decayTime,
                sustain: params.sustainLevel,
                release: params.releaseTime
            };
        }

        function buildLayerSynthEnvelope(params) {
            return {
                attack: params.layerAttack,
                decay: params.layerDecay,
                sustain: params.layerSustain,
                release: params.layerRelease
            };
        }

        function updateMainSynthEnvelope(params = null) {
            if (!synth || synth.disposed) return;
            const source = params || getUIParams();
            synth.set({ envelope: buildMainSynthEnvelope(source) });
        }

        function updateLayerSynthEnvelope(params = null) {
            if (!layerSynth || layerSynth.disposed) return;
            const source = params || getUIParams();
            layerSynth.set({ envelope: buildLayerSynthEnvelope(source) });
        }

        // --- Auto-start on first click ---
        let hasStarted = false;
        const clickToStart = document.getElementById('clickToStart');

        window.addEventListener('click', async (e) => {
            if (!hasStarted && !e.target.closest('#controls-panel')) {
                hasStarted = true;
                // Hide the "click to start" message
                clickToStart.style.display = 'none';
                // Move UI to corner and keep panel hidden
                uiContainer.classList.remove('is-centered');
                controlsPanel.classList.add('hidden');
                syncPanelToggleIcons();
                // Auto-start the music
                await setupAndPlay();
            }
        }, { once: true });

        // --- Event Handlers ---
        playPauseButton.addEventListener('click', async () => {
            if (!isSetup) {
                if (uiContainer.classList.contains('is-centered')) {
                    uiContainer.classList.remove('is-centered');
                    controlsPanel.classList.add('hidden');
                    syncPanelToggleIcons();
                }
                await setupAndPlay();
            } else if (Tone.Transport.state === 'started') {
                Tone.Transport.pause();
                playPauseButton.textContent = 'Play';
            } else {
                Tone.Transport.start();
                playPauseButton.textContent = 'Pause';
            }
        });

        stopButton.addEventListener('click', () => {
            if (!isSetup) return;
            Tone.Transport.stop();
            if (automationLoopEvent !== null) {
                Tone.Transport.clear(automationLoopEvent);
                automationLoopEvent = null;
            }
            cleanupAudio(true);
            isSetup = false;
            playPauseButton.textContent = 'Play';
            loopCounter = 0; // Reset loop counter on stop

            if (!uiContainer.classList.contains('is-centered')) {
                uiContainer.classList.add('is-centered');
                controlsPanel.classList.remove('hidden');
                syncPanelToggleIcons();
            }
        });
        
        const sliderIds = [
            'fmTimbre', 'fmModDepth', 'attackTime', 'decayTime', 'sustainLevel', 'releaseTime',
            'laag', 'gelaagdheid', 'layerFilterControl', 'layerOffset',
            'layerAttack', 'layerDecay', 'layerSustain', 'layerRelease',
            'synthFilterFrequency', 'synthFilterSpan', 'synthFilterQ', 'synthFilterMix',
            'fundamentalNote', 'fundamentalOctave', 'gevoel', 'noteSpread', 'patternLength',
            'nDelayChains', 'bpm', 'reverb', 'granular', 'granularTexture',
            'automation', 'automationTiming', 'automationSpeed', 'scaleCycleInterval', 'drumRhythm',
            'flutterDepth', 'flutterRate',
            'kickVolume', 'snareVolume', 'hihatVolume',
            'clapVolume', 'kickFilter', 'snareFilter', 'hihatFilter',
            'clapFilter', 'kickChance', 'snareChance', 'hihatChance',
            'clapChance', 'kickRepeat', 'snareRepeat', 'hihatRepeat',
            'clapRepeat'
        ];

        function refreshSliderDisplay(id, decimalsOverride = null) {
            const slider = document.getElementById(id);
            if (!slider) return;
            if (id === 'drumRhythm') {
                updateRhythmDisplay(parseFloat(slider.value));
                return;
            }
            const display = document.getElementById(`${id}Value`);
            if (!display) return;
            if (id === 'gevoel') {
                const scale = getScaleDefinition(parseInt(slider.value, 10));
                display.textContent = scale.name;
                return;
            }
            if (slider.tagName === 'SELECT') {
                const selectedOption = slider.options[slider.selectedIndex];
                display.textContent = selectedOption ? selectedOption.textContent : slider.value;
                return;
            }
            const decimals = (decimalsOverride !== null && decimalsOverride !== undefined)
                ? decimalsOverride
                : (slider.step && slider.step.includes('.') ? slider.step.split('.')[1].length : 0);
            display.textContent = parseFloat(slider.value).toFixed(decimals);
        }

        function updateSlider(id, value, decimals = null) {
            const slider = document.getElementById(id);
            if (!slider) return;
            slider.value = value;
            refreshSliderDisplay(id, decimals);
        }

        function syncSliderDisplays(ids = sliderIds) {
            ids.forEach(id => refreshSliderDisplay(id));
        }

        function noteNameToIndex(note) {
            return NOTE_NAMES.indexOf(note);
        }

        function midiToFrequency(midi) {
            return 440 * Math.pow(2, (midi - 69) / 12);
        }

        function noteNameToMidi(note, octave) {
            const noteIndex = Math.max(0, noteNameToIndex(note));
            return ((octave + 1) * 12) + noteIndex;
        }

        function noteToFrequency(note, octave) {
            const midi = noteNameToMidi(note, octave);
            return midiToFrequency(midi);
        }

        function clampScaleIndex(value) {
            return Math.max(0, Math.min(SCALE_DEFINITIONS.length - 1, Math.round(value)));
        }

        function getScaleDefinition(index) {
            return SCALE_DEFINITIONS[clampScaleIndex(index)];
        }

        function degreeToSemitone(degree, scaleSemitones) {
            if (!scaleSemitones || !scaleSemitones.length) return degree * 2;
            const len = scaleSemitones.length;
            const normalizedDegree = Math.floor(degree);
            const octave = Math.floor(normalizedDegree / len);
            const idx = ((normalizedDegree % len) + len) % len;
            return scaleSemitones[idx] + octave * 12;
        }

        function randomizeParameters(initialLoad = false) {
            // Initial load uses shorter attack (0-0.2), randomize button uses wider range (0-0.9)
            const attackRange = initialLoad ? Random.float(0.0, 0.2) : Random.float(0.0, 0.9);
            updateSlider('attackTime', attackRange, 2);
            updateSlider('decayTime', Random.float(0.05, 2.5), 2);
            updateSlider('sustainLevel', Random.float(0.1, 0.9), 2);
            updateSlider('releaseTime', Random.float(0.1, 5.0), 1);
            updateSlider('layerAttack', Random.float(0.01, 0.6), 2);
            updateSlider('layerDecay', Random.float(0.1, 2.0), 2);
            updateSlider('layerSustain', Random.float(0.1, 0.9), 2);
            updateSlider('layerRelease', Random.float(0.2, 4.5), 1);
            const randomNote = Random.select(NOTE_NAMES);
            const randomOctave = Random.int(2, 5);
            const newFmTimbre = parseFloat(document.getElementById('fmTimbre').value);
            const newScaleIndex = Random.int(0, SCALE_DEFINITIONS.length - 1);
            updateSlider('fundamentalNote', randomNote);
            updateSlider('fundamentalOctave', randomOctave, 0);
            updateSlider('gevoel', newScaleIndex, 0);
            updateSlider('nDelayChains', Random.int(0, 3), 0);
            updateSlider('reverb', Random.float(0.0, 0.5), 2);
            updateSlider('bpm', Random.int(70, 150), 0);
            updateSlider('patternLength', Random.select([2, 4, 8, 16]), 0);
            updateSlider('automationSpeed', Random.float(0.8, 3.5), 1);
            updateSlider('drumRhythm', Random.float(0, 1), 2);
            updateSlider('layerFilterControl', Random.float(0.2, 0.85), 2);
            updateSlider('layerOffset', Random.float(0, 0.7), 2);
            updateSlider('synthFilterFrequency', Random.float(200, 3200), 0);
            updateSlider('synthFilterSpan', Random.float(80, 1200), 0);
            updateSlider('synthFilterQ', Random.float(6, 18), 1);
            const blendPercent = Math.round(Random.float(60, 100));
            updateSlider('synthFilterMix', blendPercent, 0);
            setSynthFilterMixAmount(blendPercent / 100);
            updateSlider('granularTexture', Random.float(0.2, 0.9), 2);
            updateSlider('flutterDepth', Random.float(0, 0.6), 2);
            updateSlider('flutterRate', Random.float(0.1, 0.9), 2);

            const randomMidi = noteNameToMidi(randomNote, randomOctave);
            const fundamentalHue = mapValue(randomMidi, 36, 84, 30, 330);
            const timbreShift = mapValue(newFmTimbre, 0, 10, 0, 120);
            const gevoelHue = mapValue(newScaleIndex, 0, SCALE_DEFINITIONS.length - 1, 0, 360);
            currentBaseHue = (fundamentalHue + timbreShift + gevoelHue) % 360;
            syncSliderDisplays();
        }

        randomizeButton.addEventListener('click', () => {
            randomizeParameters(false); // Use wider attack range
            startAutomation();
            if (isSetup) {
                generateSoundscape();
            }
        });

        // --- Real-time Parameter Updates ---
        let regenerateTimeout = null;
        let regenerateSkipFade = false;
        const scheduleRegeneration = (skipFade = false) => {
            if (skipFade) regenerateSkipFade = true;
            if (regenerateTimeout) clearTimeout(regenerateTimeout);
            regenerateTimeout = setTimeout(() => {
                generateSoundscape({ skipFade: regenerateSkipFade });
                regenerateSkipFade = false;
            }, 0);
        };

        sliderIds.forEach(id => {
            const slider = document.getElementById(id);
            const display = document.getElementById(`${id}Value`);

            const updateFunction = (e) => {
                const value = e.target.value;
                if (id === 'drumRhythm') {
                    updateRhythmDisplay(parseFloat(value));
                } else {
                    refreshSliderDisplay(id);
                }

                if (id === 'synthFilterMix') {
                    setSynthFilterMixAmount(parseFloat(value) / 100);
                }

                if (isSetup) {
                    switch(id) {
                        case 'fmTimbre': {
                            if (synth) synth.set({ modulationIndex: mapValue(value, 0, 10, 0, 20) });
                            // Update hue based on fmTimbre
                            const baseNote = document.getElementById('fundamentalNote').value;
                            const baseOctave = parseInt(document.getElementById('fundamentalOctave').value);
                            const fundamentalHue = mapValue(noteNameToMidi(baseNote, baseOctave), 36, 84, 30, 330);
                            const timbreShift = mapValue(value, 0, 20, 0, 120);
                            currentBaseHue = (fundamentalHue + timbreShift) % 360;
                            break;
                        }
                        case 'fmModDepth':
                             if (synth) synth.set({ modulationEnvelope: { decay: value } });
                            break;
                        case 'attackTime':
                        case 'decayTime':
                        case 'sustainLevel':
                        case 'releaseTime':
                            updateMainSynthEnvelope();
                            break;
                        case 'layerAttack':
                        case 'layerDecay':
                        case 'layerSustain':
                        case 'layerRelease':
                            updateLayerSynthEnvelope();
                            break;
                        case 'laag':
                            currentLayerTranspose = parseInt(value);
                            break;
                        case 'gelaagdheid':
                            // Update filter and volume in real-time
                            if (layerVolume) {
                                layerVolume.volume.value = mapValue(value, 0, 1, -72, -18);
                            }
                            currentLayerDepth = parseFloat(value);
                            break;
                        case 'layerFilterControl': {
                            applyLayerLowpassCenter(mapLayerFilterValue(value));
                            break;
                        }
                        case 'layerOffset': {
                            currentLayerOffsetSeconds = mapValue(value, 0, 1, 0, 0.6);
                            break;
                        }
                        case 'synthFilterFrequency':
                        case 'synthFilterSpan':
                        case 'synthFilterQ': {
                            const frequency = parseFloat(document.getElementById('synthFilterFrequency').value);
                            const span = parseFloat(document.getElementById('synthFilterSpan').value);
                            const qValue = parseFloat(document.getElementById('synthFilterQ').value);
                            applySynthFilterSettings({ frequency, span, q: qValue });
                            break;
                        }
                        case 'synthFilterMix':
                            break;
                        case 'reverb':
                            if (reverb) reverb.wet.value = value;
                            break;
                        case 'drumRhythm':
                            updateDrumPart(getUIParams());
                            break;
                        case 'kickRepeat':
                        case 'snareRepeat':
                        case 'hihatRepeat':
                        case 'clapRepeat':
                            if (isSetup) {
                                const params = getUIParams();
                                updateDrumPart(params);
                            }
                            break;
                        case 'kickFilter':
                        case 'snareFilter':
                        case 'hihatFilter':
                        case 'clapFilter':
                            updateDrumFilterFrequency(id.replace('Filter', ''));
                            break;
                        case 'kickChance':
                        case 'snareChance':
                        case 'hihatChance':
                        case 'clapChance':
                            break;
                        case 'kickVolume':
                            if (kickVolume) {
                                kickVolume.volume.value = mapValue(value, 0, 1, KICK_VOLUME_DB_RANGE.min, KICK_VOLUME_DB_RANGE.max);
                            }
                            break;
                        case 'snareVolume':
                            if (snareVolume) {
                                snareVolume.volume.value = mapValue(value, 0, 1, DRUM_VOLUME_DB_RANGE.min, DRUM_VOLUME_DB_RANGE.max);
                            }
                            break;
                        case 'hihatVolume':
                            if (hihatVolume) {
                                hihatVolume.volume.value = mapValue(value, 0, 1, HIHAT_DB_RANGE.min, HIHAT_DB_RANGE.max);
                            }
                            break;
                        case 'clapVolume':
                            if (clapVolume) {
                                clapVolume.volume.value = mapValue(value, 0, 1, CLAP_DB_RANGE.min, CLAP_DB_RANGE.max);
                            }
                            break;
                        case 'bpm':
                             Tone.Transport.bpm.value = value;
                            break;
                        case 'fundamentalNote':
                        case 'fundamentalOctave':
                            handleFundamentalChange();
                            break;
                        case 'noteSpread': {
                            applySpreadDetune(value);
                            break;
                        }
                        case 'nDelayChains':
                            updateDelayWetness(value);
                            break;
                        case 'patternLength':
                            updatePatternPlaybackLength(parseInt(value, 10));
                            break;
                        case 'gevoel': {
                            handleScaleChange();
                            break;
                        }
                        case 'automation':
                        case 'automationTiming':
                        case 'automationSpeed':
                            startAutomation();
                            break;
                        case 'granular':
                            currentGranularWet = parseFloat(value);
                            break;
                        case 'granularTexture':
                            refreshGranularLayerFromUI();
                            break;
                        case 'scaleCycleInterval':
                            scaleCyclePosition = 0;
                            break;
                        case 'flutterDepth':
                        case 'flutterRate':
                            applyFlutterWowSettings(getUIParams());
                            break;
                    }
                }
            };

            slider.addEventListener('input', updateFunction);
        });

        // --- State Management ---
        function getCurrentState() {
            const params = getUIParams();
            const stateData = {
                fmTimbre: params.fmTimbre,
                fmModDepth: params.fmModDepth,
                attackTime: params.attackTime,
                decayTime: params.decayTime,
                sustainLevel: params.sustainLevel,
                releaseTime: params.releaseTime,
                laag: params.laag,
                gelaagdheid: params.gelaagdheid,
                layerFilter: params.layerFilter,
                layerOffset: params.layerOffset,
                layerAttack: params.layerAttack,
                layerDecay: params.layerDecay,
                layerSustain: params.layerSustain,
                layerRelease: params.layerRelease,
                synthFilterFrequency: params.synthFilterFrequency,
                synthFilterSpan: params.synthFilterSpan,
                synthFilterQ: params.synthFilterQ,
                synthFilterMix: params.synthFilterMix,
                fundamentalNote: params.fundamentalNote,
                fundamentalOctave: params.fundamentalOctave,
                fundamental: params.fundamental,
                scaleIndex: params.scaleIndex,
                gevoel: params.gevoel,
                noteSpread: params.noteSpread,
                patternLength: params.patternLength,
                nDelayChains: params.nDelayChains,
                bpm: params.bpm,
                reverb: params.reverbWet,
                granular: params.granular,
                granularTexture: params.granularTexture,
                automation: params.automation,
                automationTiming: params.automationTiming,
                automationSpeed: params.automationSpeed,
                scaleCycleInterval: params.scaleCycleInterval,
                scaleCycleSteps: params.scaleCycleSteps,
                flutterDepth: params.flutterDepth,
                flutterRate: params.flutterRate,
                drumRhythm: params.drumRhythm,
                kickVol: params.kickVol,
                snareVol: params.snareVol,
                hihatVol: params.hihatVol,
                clapVol: params.clapVol,
                kickFilter: params.kickFilter,
                snareFilter: params.snareFilter,
                hihatFilter: params.hihatFilter,
                clapFilter: params.clapFilter,
                kickChance: params.kickChance,
                snareChance: params.snareChance,
                hihatChance: params.hihatChance,
                clapChance: params.clapChance,
                kickRepeat: params.kickRepeat,
                snareRepeat: params.snareRepeat,
                hihatRepeat: params.hihatRepeat,
                clapRepeat: params.clapRepeat,
                drumFilterBypass: { ...drumFilterBypassStates }
            };
            return btoa(JSON.stringify(stateData));
        }

        function applyState(stateString) {
            try {
                const stateData = JSON.parse(atob(stateString));

                updateSlider('fmTimbre', stateData.fmTimbre, 1);
                updateSlider('fmModDepth', stateData.fmModDepth, 2);
                updateSlider('attackTime', stateData.attackTime, 2);
                updateSlider('decayTime', stateData.decayTime ?? 0.8, 2);
                updateSlider('sustainLevel', stateData.sustainLevel ?? 0.4, 2);
                updateSlider('releaseTime', stateData.releaseTime, 1);
                updateSlider('laag', stateData.laag || 0, 0);
                updateSlider('gelaagdheid', stateData.gelaagdheid || 0, 2);
                updateSlider('layerFilterControl', stateData.layerFilter ?? 0.5, 2);
                updateSlider('layerOffset', stateData.layerOffset || 0, 2);
                updateSlider('layerAttack', stateData.layerAttack ?? 0.08, 2);
                updateSlider('layerDecay', stateData.layerDecay ?? 0.6, 2);
                updateSlider('layerSustain', stateData.layerSustain ?? 0.5, 2);
                updateSlider('layerRelease', stateData.layerRelease ?? 2.2, 1);
                updateSlider('synthFilterFrequency', stateData.synthFilterFrequency ?? SYNTH_FILTER_DEFAULT_FREQUENCY, 0);
                updateSlider('synthFilterSpan', stateData.synthFilterSpan ?? SYNTH_FILTER_DEFAULT_SPAN, 0);
                updateSlider('synthFilterQ', stateData.synthFilterQ ?? SYNTH_FILTER_DEFAULT_Q, 1);
                const storedFilterMix = Math.max(0, Math.min(1, stateData.synthFilterMix ?? 1));
                updateSlider('synthFilterMix', Math.round(storedFilterMix * 100), 0);
                setSynthFilterMixAmount(storedFilterMix);
                const fallbackMidi = (() => {
                    if (stateData.fundamentalNote && typeof stateData.fundamentalOctave === 'number') {
                        return noteNameToMidi(stateData.fundamentalNote, stateData.fundamentalOctave);
                    }
                    if (stateData.fundamental) {
                        return Math.round(69 + 12 * Math.log2(stateData.fundamental / 440));
                    }
                    return 60;
                })();
                const fallbackNote = NOTE_NAMES[((fallbackMidi % 12) + 12) % 12] || 'C';
                const fallbackOctave = Math.max(1, Math.min(6, Math.floor(fallbackMidi / 12) - 1));
                updateSlider('fundamentalNote', stateData.fundamentalNote || fallbackNote);
                updateSlider('fundamentalOctave', stateData.fundamentalOctave ?? fallbackOctave, 0);
                const restoredScaleIndex = (typeof stateData.scaleIndex === 'number')
                    ? stateData.scaleIndex
                    : clampScaleIndex((stateData.gevoel ?? 0) * (SCALE_DEFINITIONS.length - 1));
                updateSlider('gevoel', restoredScaleIndex, 0);
                updateSlider('noteSpread', stateData.noteSpread, 0);
                updateSlider('patternLength', stateData.patternLength, 0);
                updateSlider('nDelayChains', stateData.nDelayChains, 0);
                updateSlider('bpm', stateData.bpm, 0);
                updateSlider('reverb', stateData.reverb, 2);
                updateSlider('granular', stateData.granular || 0, 2);
                updateSlider('granularTexture', stateData.granularTexture ?? 0.5, 2);
                updateSlider('automation', stateData.automation || 0, 2);
                updateSlider('automationTiming', stateData.automationTiming || 0, 0);
                updateSlider('automationSpeed', stateData.automationSpeed || 2, 1);
                updateSlider('scaleCycleInterval', stateData.scaleCycleInterval ?? 0, 0);
                const storedSteps = stateData.scaleCycleSteps || [];
                ['scaleCycleStep1', 'scaleCycleStep2', 'scaleCycleStep3', 'scaleCycleStep4'].forEach((id, idx) => {
                    const select = document.getElementById(id);
                    if (!select) return;
                    select.value = storedSteps[idx] || '';
                });
                scaleCyclePosition = 0;
                updateSlider('flutterDepth', stateData.flutterDepth || 0, 2);
                updateSlider('flutterRate', stateData.flutterRate ?? 0.5, 2);
                updateSlider('drumRhythm', stateData.drumRhythm ?? DEFAULT_DRUM_RHYTHM, 2);
                updateSlider('kickVolume', stateData.kickVol || 0, 2);
                updateSlider('snareVolume', stateData.snareVol || 0, 2);
                updateSlider('hihatVolume', stateData.hihatVol || 0, 2);
                updateSlider('clapVolume', stateData.clapVol || 0, 2);
                updateSlider('kickFilter', stateData.kickFilter ?? DRUM_FILTER_SETTINGS.kick.frequency, 0);
                updateSlider('snareFilter', stateData.snareFilter ?? DRUM_FILTER_SETTINGS.snare.frequency, 0);
                updateSlider('hihatFilter', stateData.hihatFilter ?? DRUM_FILTER_SETTINGS.hihat.frequency, 0);
                updateSlider('clapFilter', stateData.clapFilter ?? DRUM_FILTER_SETTINGS.clap.frequency, 0);
                updateSlider('kickChance', Math.round((stateData.kickChance ?? 1) * 100), 0);
                updateSlider('snareChance', Math.round((stateData.snareChance ?? 1) * 100), 0);
                updateSlider('hihatChance', Math.round((stateData.hihatChance ?? 1) * 100), 0);
                updateSlider('clapChance', Math.round((stateData.clapChance ?? 1) * 100), 0);
                updateDrumFilterFrequency('kick');
                updateDrumFilterFrequency('snare');
                updateDrumFilterFrequency('hihat');
                updateDrumFilterFrequency('clap');
                updateSlider('kickRepeat', stateData.kickRepeat || 0, 2);
                updateSlider('snareRepeat', stateData.snareRepeat || 0, 2);
                updateSlider('hihatRepeat', stateData.hihatRepeat || 0, 2);
                updateSlider('clapRepeat', stateData.clapRepeat || 0, 2);

                const drumBypassState = stateData.drumFilterBypass || {};
                Object.keys(DRUM_FILTER_SETTINGS).forEach(drum => {
                    const stored = Object.prototype.hasOwnProperty.call(drumBypassState, drum)
                        ? drumBypassState[drum]
                        : DEFAULT_DRUM_FILTER_BYPASS[drum];
                    setDrumFilterBypassState(drum, stored, { skipRouting: true, skipStateUpdate: true });
                });

                const fundamentalHue = mapValue(fallbackMidi, 36, 84, 30, 330);
                const timbreShift = mapValue(stateData.fmTimbre, 0, 20, 0, 120);
                const gevoelHue = mapValue(restoredScaleIndex, 0, SCALE_DEFINITIONS.length - 1, 0, 360);
                currentBaseHue = (fundamentalHue + timbreShift + gevoelHue) % 360;

                if (isSetup) {
                    generateSoundscape();
                }

                startAutomation();
                syncSliderDisplays();

                return true;
            } catch (e) {
                console.error('Invalid state:', e);
                return false;
            }
        }

        function updateStateDisplay() {
            stateInput.value = getCurrentState();
        }

        copyStateButton.addEventListener('click', async () => {
            const state = getCurrentState();
            try {
                await navigator.clipboard.writeText(state);
                copyStateButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyStateButton.textContent = 'Copy';
                }, 1500);
            } catch (e) {
                stateInput.select();
                document.execCommand('copy');
                copyStateButton.textContent = 'Copied!';
                setTimeout(() => {
                    copyStateButton.textContent = 'Copy';
                }, 1500);
            }
        });

        pasteStateButton.addEventListener('click', async () => {
            try {
                const stateString = await navigator.clipboard.readText();
                if (applyState(stateString)) {
                    updateStateDisplay();
                    pasteStateButton.textContent = 'Applied!';
                    setTimeout(() => {
                        pasteStateButton.textContent = 'Paste';
                    }, 1500);
                } else {
                    pasteStateButton.textContent = 'Invalid!';
                    setTimeout(() => {
                        pasteStateButton.textContent = 'Paste';
                    }, 1500);
                }
            } catch (e) {
                const stateString = prompt('Paste your state here:');
                if (stateString && applyState(stateString)) {
                    updateStateDisplay();
                    pasteStateButton.textContent = 'Applied!';
                    setTimeout(() => {
                        pasteStateButton.textContent = 'Paste';
                    }, 1500);
                } else if (stateString) {
                    pasteStateButton.textContent = 'Invalid!';
                    setTimeout(() => {
                        pasteStateButton.textContent = 'Paste';
                    }, 1500);
                }
            }
        });

        // Update state display whenever sliders change
        sliderIds.forEach(id => {
            document.getElementById(id).addEventListener('input', updateStateDisplay);
        });

        ['scaleCycleStep1', 'scaleCycleStep2', 'scaleCycleStep3', 'scaleCycleStep4'].forEach(id => {
            const select = document.getElementById(id);
            if (!select) return;
            select.addEventListener('input', () => {
                scaleCyclePosition = 0;
                updateStateDisplay();
            });
        });

        // --- Automation System ---
        let automationInterval = null;
        let loopCounter = 0;
        const automatableSliders = [
            'fmTimbre', 'fmModDepth', 'attackTime', 'decayTime', 'sustainLevel', 'releaseTime',
            'reverb', 'bpm', 'gelaagdheid', 'gevoel',
            'noteSpread', 'patternLength', 'nDelayChains',
            'laag', 'layerFilterControl', 'layerOffset',
            'layerAttack', 'layerDecay', 'layerSustain', 'layerRelease',
            'synthFilterFrequency', 'synthFilterSpan', 'synthFilterQ', 'synthFilterMix',
            'granular', 'granularTexture', 'flutterDepth', 'flutterRate'
        ];

        function automateParameter() {
            const automationAmount = parseFloat(document.getElementById('automation').value);

            if (automationAmount > 0 && isSetup) {
                const iterations = 1 + Math.floor(automationAmount * 3);
                for (let i = 0; i < iterations; i++) {
                    const sliderId = Random.select(automatableSliders);
                    const slider = document.getElementById(sliderId);
                    if (!slider) continue;

                    const min = parseFloat(slider.min);
                    const max = parseFloat(slider.max);
                    const current = parseFloat(slider.value);
                    const range = max - min;

                    // Calculate subtle change based on automation amount
                    const maxChange = range * (0.05 + automationAmount * 0.1);
                    const change = Random.float(-maxChange, maxChange);
                    let newValue = Math.max(min, Math.min(max, current + change));

                    const step = parseFloat(slider.step) || 0;
                    if (step > 0) {
                        newValue = Math.round(newValue / step) * step;
                        newValue = Math.max(min, Math.min(max, newValue));
                    }

                    slider.value = newValue;
                    const event = new Event('input', { bubbles: true });
                    slider.dispatchEvent(event);
                }
            }
        }

        function startAutomation() {
            if (automationInterval) clearInterval(automationInterval);

            const speed = Math.max(0.4, parseFloat(document.getElementById('automationSpeed').value) || 2);
            const intervalTime = speed * 1000;

            // Time-based automation (when timing is 0)
            automationInterval = setInterval(() => {
                const automationTiming = parseInt(document.getElementById('automationTiming').value);

                // Only use time-based automation when timing is set to 0
                if (automationTiming === 0) {
                    if (Random.coinToss(0.35)) { // 35% chance each interval
                        automateParameter();
                    }
                }
            }, intervalTime);
        }

        // Start automation system
        startAutomation();

        // --- Visualizer Functies ---
        function triggerDrumVisual(drumType, intensity) {
            if (intensity <= 0 || !isSetup) return;

            const hue = currentBaseHue;

            switch(drumType) {
                case 'kick':
                    // Kick: compact, slowly growing circles at fixed grid bars
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

                case 'snare':
                    // Snare: Sharp diagonal streaks
                    const snareLength = Math.floor(mapValue(intensity, 0, 1, 3, 8));
                    for (let i = 0; i < 4; i++) {
                        const startX = Random.int(0, cols - 1);
                        const startY = Random.int(0, rows - 1);
                        const angle = (i * Math.PI / 2) + (Math.PI / 4); // Diagonal angles

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

                case 'hihat':
                    // Hi-hat: Small scattered sparkles
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

                case 'clap':
                    // Clap: Vertical columns from top and bottom
                    const numColumns = Math.floor(mapValue(intensity, 0, 1, 2, 4));
                    for (let i = 0; i < numColumns; i++) {
                        const x = Random.int(0, cols - 1);
                        const height = Math.floor(mapValue(intensity, 0, 1, 2, 5));

                        // Top down
                        for (let y = 0; y < height && y < rows; y++) {
                            if (grid[x] && grid[x][y]) {
                                grid[x][y].life = Math.min(0.9, grid[x][y].life + intensity * 0.5);
                                grid[x][y].hue = (hue + 240) % 360;
                                grid[x][y].saturation = 55;
                                grid[x][y].lightness = 65;
                                grid[x][y].fadeSpeed = 0.006;
                            }
                        }

                        // Bottom up
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
        }

        function triggerGridPattern(velocity = 1.0, isGrain = false, isLayer = false, transposeAmount = 0) {
            // Calculate hue shift based on transpose amount (-24 to +24 semitones)
            const transposeHueShift = isLayer ? mapValue(transposeAmount, -24, 24, -120, 120) : 0;
            let hue = (currentBaseHue + Random.float(-8, 8) + transposeHueShift + 360) % 360;

            // Granular visual: rare, tiny sparkles
            if (isGrain) {
                // Only show 1 in 8 grains visually
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
                        grid[x][y].fadeSpeed = 0.005; // Very slow fade
                    }
                }
                return;
            }

            const simpleColor = useSimpleStartColor();
            if (simpleColor) {
                hue = simpleColor.hue;
            }

            // Regular visual patterns - very slow gentle stacking
            const eventType = Math.random();
            const saturation = simpleColor ? simpleColor.saturation : Random.float(45, 60);
            const lightness = simpleColor ? simpleColor.lightness : Random.float(55, 65);
            const fadeSpeed = mapValue(velocity, 0.1, 0.7, 0.006, 0.003); // Very slow fade

            if (eventType < 0.04) { // Occasional full screen wash
                for (let i = 0; i < cols; i++) {
                    for (let j = 0; j < rows; j++) {
                        const cell = grid[i][j];
                        if (cell.life <= 0.2) {
                            cell.life = Math.min(0.4, cell.life + velocity * 0.15);
                            cell.hue = hue;
                            cell.saturation = simpleColor ? simpleColor.saturation : 30;
                            cell.lightness = simpleColor ? simpleColor.lightness : 40;
                            cell.fadeSpeed = 0.002; // Very slow fade
                        }
                    }
                }
                return;
            }

            const midX = Math.ceil(cols / 2), midY = Math.ceil(rows / 2);
            // Make layered blocks bigger
            const sizeMultiplier = isLayer ? 1.3 : 1.0;
            const w = Math.floor(Random.int(2, Math.floor(cols / 2.5)) * sizeMultiplier);
            const h = Math.floor(Random.int(1, 2) * sizeMultiplier);
            const sx = Random.int(0, Math.max(1, midX - w)), sy = Random.int(0, Math.max(1, midY - h));

            for(let x = sx; x < sx + w && x < cols; x++) {
                for (let y = sy; y < sy + h && y < rows; y++) {
                     if (grid[x] && grid[x][y]) {
                        const cellsToUpdate = [
                            grid[x][y],
                            grid[cols - 1 - x] && grid[cols - 1 - x][y],
                            grid[x][rows - 1 - y],
                            grid[cols - 1 - x] && grid[cols - 1 - x][rows - 1 - y]
                        ].filter(cell => cell !== undefined);

                        cellsToUpdate.forEach(cell => {
                            if (cell) {
                                // Allow gentle stacking
                                cell.life = Math.min(1.2, cell.life + velocity * 0.5);
                                cell.hue = hue;
                                cell.saturation = saturation;
                                cell.lightness = lightness;
                                cell.fadeSpeed = fadeSpeed;
                            }
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
            
            if (isSetup) {
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

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                pauseVisualizer();
            } else if (!isVisualizerFrozen) {
                resumeVisualizer();
            }
        });

        // Initial randomization and start drawing loop on load
        randomizeParameters(true); // Use short attack range on initial load
        syncSliderDisplays();
        updateStateDisplay();
        drawVisualizer();
        
    </script>
</body>
</html>


