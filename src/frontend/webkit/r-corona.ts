import {
  css,
  customElement,
  html,
  property,
  RorschachBase
} from './base.js';

// ─── Corona background ───
//
// A WebGL fragment-shader solar-eclipse corona rendered onto a <canvas> in
// the shadow DOM. The shader code is self-contained; the element manages the
// RAF loop, resize, and visibility-pause via Lit lifecycle hooks.
//
// `r-shell` places `<r-corona>` behind the workspace panel. The `.paused`
// property can be used to pause the animation (e.g. when the tab is hidden).

const VERT_SRC = `
  attribute vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`;

const FRAG_SRC = `
  precision highp float;
  uniform vec2  u_res;
  uniform float u_time;

  float hash(vec2 p) {
    p = fract(p * vec2(127.1, 311.7));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1,0)), f.x),
      mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x),
      f.y
    );
  }

  float fbm3(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  float fbm5(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * vnoise(p); p *= 2.07; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - u_res * 0.5) / min(u_res.x, u_res.y);
    float r  = length(uv);
    float ag = atan(uv.y, uv.x);
    float t  = u_time * 0.18;

    const float MOON = 0.185;

    vec3 col = vec3(0.001, 0.002, 0.015);

    for (int i = 0; i < 2; i++) {
      float scale = 40.0 + float(i) * 24.0;
      vec2  sg    = uv * scale + vec2(float(i) * 17.3, float(i) * 9.1);
      float s     = hash(floor(sg));
      if (s > 0.962) {
        vec2  sp = fract(sg) - 0.5;
        float sr = length(sp);
        float sb = smoothstep(0.2, 0.0, sr) * (s - 0.962) * 26.0;
        float tw = 0.75 + 0.25 * sin(u_time * (1.0 + float(i) * 0.6) + s * 31.4);
        col += vec3(0.88, 0.92, 1.0) * sb * tw;
      }
    }

    vec2 angVec = vec2(cos(ag), sin(ag));

    float aN1 = fbm3(angVec * 2.8 + t * 0.14);
    float aN2 = fbm3(angVec * 4.5 - t * 0.09 + 1.3);
    float aN3 = fbm3(angVec * 1.6 + vec2(t * 0.07, -t * 0.11) + 2.7);
    float aN4 = fbm3(angVec * 6.0 + t * 0.06 + 5.2);

    float s1 = 0.5 + 0.5 * cos(ag *  3.0 + aN1 * 3.2);
    float s2 = 0.5 + 0.5 * cos(ag *  5.0 + aN2 * 2.8 + 1.3);
    float s3 = 0.5 + 0.5 * cos(ag *  7.0 + aN3 * 2.0 - 0.8);
    float s4 = 0.5 + 0.5 * cos(ag * 11.0 + aN4 * 1.5 + 2.1);
    float streamer = pow(s1,  6.0) * 0.44
                   + pow(s2,  8.0) * 0.30
                   + pow(s3, 10.0) * 0.16
                   + pow(s4, 12.0) * 0.10;

    float coronaR   = max(0.0, r - MOON);
    float innerFall = exp(-14.0 * coronaR) * smoothstep(MOON, MOON + 0.004, r);
    float outerFall = exp(-2.5  * coronaR) * smoothstep(MOON, MOON + 0.015, r);

    float radTex = fbm3(uv * 5.5 + vec2(t * 0.14, t * 0.11));

    float pulse = 0.75 + 0.25 * sin(u_time * .8) * sin(u_time * 0.1);

    float innerCorona = innerFall * (0.60 + 0.40 * radTex) * pulse;

    float stPulse = 0.50 + 0.50 * sin(u_time * 0.75 + aN1 * 6.28)
                                * sin(u_time * 0.40 - aN2 * 4.00 + 1.3);
    float outerCorona = outerFall * (0.04 + 0.96 * streamer * streamer) * stPulse;

    float chromo = smoothstep(MOON - 0.002, MOON + 0.001, r)
                 * smoothstep(MOON + 0.014, MOON + 0.004, r);

    float promN1   = fbm5(angVec * 4.0 + t * 0.35);
    float promN2   = fbm3(angVec * 2.5 - t * 0.28 + 3.7);
    float promRing = smoothstep(MOON, MOON + 0.006, r) * smoothstep(MOON + 0.07, MOON + 0.015, r);
    float prom     = promRing * (pow(max(0.0, promN1 - 0.28) / 0.72, 2.0) * 3.5
                               + pow(max(0.0, promN2 - 0.35) / 0.65, 2.5) * 2.5);

    vec3 coronaWarm = vec3(1.00, 0.97, 0.88);
    vec3 coronaCool = vec3(0.80, 0.90, 1.00);
    vec3 chromoCol  = vec3(1.00, 0.92, 0.60);
    vec3 promColor  = vec3(0.98, 0.18, 0.12);

    float outerBlend = smoothstep(MOON, MOON + 0.5, r);

    col += coronaWarm                              * innerCorona * 3.5;
    col += mix(coronaWarm, coronaCool, outerBlend) * outerCorona * 2.2;
    col += chromoCol * chromo * 1.6;
    col += promColor * prom;

    float moon = smoothstep(MOON + 0.003, MOON, r);
    col *= 1.0 - moon;

    col = col / (col + 0.55);
    col = pow(col, vec3(0.9));

    gl_FragColor = vec4(col, 1.0);
  }
`;

@customElement('r-corona')
export class RCorona extends RorschachBase {
  @property({ type: Boolean }) paused = false;

  private _canvas: HTMLCanvasElement | null = null;
  private _gl: WebGLRenderingContext | null = null;
  private _uRes: WebGLUniformLocation | null = null;
  private _uTime: WebGLUniformLocation | null = null;
  private _raf: number | null = null;
  private _t0 = 0;
  private _lastFrameTs = 0;
  private _resizeObs: ResizeObserver | null = null;
  private _onVisibilityChange = () => {
    this.paused = document.hidden;
  };

  static override styles = css`
    :host {
      display: block;
      position: absolute;
      inset: 0 8px 8px 0;
      z-index: -1;
      pointer-events: none;
      border-radius: 12px;
      overflow: hidden;
    }
    canvas {
      width: 100%;
      height: 100%;
      display: block;
    }
  `;

  override render() {
    return html`<canvas></canvas>`;
  }

  override firstUpdated() {
    this._canvas = this.renderRoot.querySelector('canvas');
    if (!this._canvas) return;

    this._resizeCanvas();
    this._initGL();

    if (this._gl) {
      this._t0 = performance.now();
      this._startLoop();

      document.addEventListener('visibilitychange', this._onVisibilityChange);

      if (typeof ResizeObserver !== 'undefined') {
        this._resizeObs = new ResizeObserver(() => {
          if (this._canvas && this._gl) {
            this._resizeCanvas();
            this._gl.viewport(0, 0, this._canvas.width, this._canvas.height);
          }
        });
        this._resizeObs.observe(this._canvas);
      }
    }
  }

  override updated(changedProperties: Map<string | symbol, unknown>) {
    if (changedProperties.has('paused')) {
      if (this.paused) {
        this._stopLoop();
      } else if (this._gl) {
        this._startLoop();
      }
    }
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this._stopLoop();
    document.removeEventListener('visibilitychange', this._onVisibilityChange);
    this._resizeObs?.disconnect();
    this._resizeObs = null;
    this._gl = null;
    this._canvas = null;
  }

  private _resizeCanvas() {
    if (!this._canvas) return;
    const w = this._canvas.clientWidth || 600;
    const h = this._canvas.clientHeight || 600;
    this._canvas.width = Math.ceil(w * 0.5);
    this._canvas.height = Math.ceil(h * 0.5);
  }

  private _initGL() {
    if (!this._canvas) return;
    const gl = this._canvas.getContext('webgl');
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };

    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(prog, 'a_pos');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    this._uRes = gl.getUniformLocation(prog, 'u_res');
    this._uTime = gl.getUniformLocation(prog, 'u_time');
    this._gl = gl;
  }

  private _startLoop() {
    if (this._raf !== null) return;
    const draw = (ts: number) => {
      this._raf = requestAnimationFrame(draw);
      if (!this._canvas || !this._gl) return;
      if (ts - this._lastFrameTs < 33) return; // ~30 fps cap
      this._lastFrameTs = ts;
      this._gl.viewport(0, 0, this._canvas.width, this._canvas.height);
      this._gl.uniform2f(this._uRes, this._canvas.width, this._canvas.height);
      this._gl.uniform1f(this._uTime, (performance.now() - this._t0) * 0.001);
      this._gl.drawArrays(this._gl.TRIANGLE_STRIP, 0, 4);
    };
    this._raf = requestAnimationFrame(draw);
  }

  private _stopLoop() {
    if (this._raf !== null) {
      cancelAnimationFrame(this._raf);
      this._raf = null;
    }
  }
}
