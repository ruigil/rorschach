const voidCanvas = document.getElementById('void-canvas')
let voidRaf = null

const VERT_SRC = `
  attribute vec2 a_pos;
  void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }
`

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
    float t  = u_time * 0.18;   // faster base speed

    const float MOON = 0.185;

    // Deep space — near-total dark during totality
    vec3 col = vec3(0.001, 0.002, 0.015);

    // Stars — more visible during eclipse
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

    // Angle unit vector — avoids atan seam for noise sampling
    vec2 angVec = vec2(cos(ag), sin(ag));

    // Angular noise — each layer evolves at a distinct rate
    float aN1 = fbm3(angVec * 2.8 + t * 0.14);
    float aN2 = fbm3(angVec * 4.5 - t * 0.09 + 1.3);
    float aN3 = fbm3(angVec * 1.6 + vec2(t * 0.07, -t * 0.11) + 2.7);
    float aN4 = fbm3(angVec * 6.0 + t * 0.06 + 5.2);   // fine high-freq layer

    // Streamer rays — high powers create sharp bright rays against dark gaps
    float s1 = 0.5 + 0.5 * cos(ag *  3.0 + aN1 * 3.2);
    float s2 = 0.5 + 0.5 * cos(ag *  5.0 + aN2 * 2.8 + 1.3);
    float s3 = 0.5 + 0.5 * cos(ag *  7.0 + aN3 * 2.0 - 0.8);
    float s4 = 0.5 + 0.5 * cos(ag * 11.0 + aN4 * 1.5 + 2.1);
    float streamer = pow(s1,  6.0) * 0.44
                   + pow(s2,  8.0) * 0.30
                   + pow(s3, 10.0) * 0.16
                   + pow(s4, 12.0) * 0.10;

    // Radial corona falloffs
    float coronaR   = max(0.0, r - MOON);
    float innerFall = exp(-14.0 * coronaR) * smoothstep(MOON, MOON + 0.004, r);
    float outerFall = exp(-2.5  * coronaR) * smoothstep(MOON, MOON + 0.015, r);

    // Fine radial fibre texture
    float radTex = fbm3(uv * 5.5 + vec2(t * 0.14, t * 0.11));

    // Pulsing heartbeat on inner corona
    float pulse = 0.75 + 0.25 * sin(u_time * .8) * sin(u_time * 0.1);

    float innerCorona = innerFall * (0.60 + 0.40 * radTex) * pulse;

    // Each streamer glows up and down independently via angle-based phase offset
    float stPulse = 0.50 + 0.50 * sin(u_time * 0.75 + aN1 * 6.28)
                                * sin(u_time * 0.40 - aN2 * 4.00 + 1.3);
    // Near-black in gaps, bright on streamer peaks
    float outerCorona = outerFall * (0.04 + 0.96 * streamer * streamer) * stPulse;

    // Chromosphere — thin warm ring at the solar limb
    float chromo = smoothstep(MOON - 0.002, MOON + 0.001, r)
                 * smoothstep(MOON + 0.014, MOON + 0.004, r);

    // Prominences — two independent noise layers, larger and faster
    float promN1   = fbm5(angVec * 4.0 + t * 0.35);
    float promN2   = fbm3(angVec * 2.5 - t * 0.28 + 3.7);
    float promRing = smoothstep(MOON, MOON + 0.006, r) * smoothstep(MOON + 0.07, MOON + 0.015, r);
    float prom     = promRing * (pow(max(0.0, promN1 - 0.28) / 0.72, 2.0) * 3.5
                               + pow(max(0.0, promN2 - 0.35) / 0.65, 2.5) * 2.5);

    // Colors
    vec3 coronaWarm = vec3(1.00, 0.97, 0.88);   // warm white inner corona
    vec3 coronaCool = vec3(0.80, 0.90, 1.00);   // silver-blue outer streamers
    vec3 chromoCol  = vec3(1.00, 0.92, 0.60);   // warm amber chromosphere
    vec3 promColor  = vec3(0.98, 0.18, 0.12);   // H-alpha red prominence

    float outerBlend = smoothstep(MOON, MOON + 0.5, r);

    col += coronaWarm                              * innerCorona * 3.5;
    col += mix(coronaWarm, coronaCool, outerBlend) * outerCorona * 2.2;
    col += chromoCol * chromo * 1.6;
    col += promColor * prom;

    // Moon — absolute black occluder
    float moon = smoothstep(MOON + 0.003, MOON, r);
    col *= 1.0 - moon;

    // Filmic tone-map
    col = col / (col + 0.55);
    col = pow(col, vec3(0.9));

    gl_FragColor = vec4(col, 1.0);
  }
`

function initVoidGL() {
  const gl = voidCanvas.getContext('webgl')
  if (!gl) return null

  function compile(type, src) {
    const sh = gl.createShader(type)
    gl.shaderSource(sh, src)
    gl.compileShader(sh)
    return sh
  }

  const prog = gl.createProgram()
  gl.attachShader(prog, compile(gl.VERTEX_SHADER,   VERT_SRC))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG_SRC))
  gl.linkProgram(prog)
  gl.useProgram(prog)

  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW)

  const aPos = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

  const uRes  = gl.getUniformLocation(prog, 'u_res')
  const uTime = gl.getUniformLocation(prog, 'u_time')

  return { gl, uRes, uTime }
}

function resizeVoidCanvas() {
  voidCanvas.width  = Math.ceil(window.innerWidth  * 0.5)
  voidCanvas.height = Math.ceil(window.innerHeight * 0.5)
}

resizeVoidCanvas()
const voidGL = initVoidGL()

if (voidGL) {
  const { gl, uRes, uTime } = voidGL
  const t0 = performance.now()
  let lastFrameTs = 0

  function drawVoidFrame(ts) {
    voidRaf = requestAnimationFrame(drawVoidFrame)
    if (ts - lastFrameTs < 33) return  // ~30 fps cap
    lastFrameTs = ts
    gl.viewport(0, 0, voidCanvas.width, voidCanvas.height)
    gl.uniform2f(uRes, voidCanvas.width, voidCanvas.height)
    gl.uniform1f(uTime, (performance.now() - t0) * 0.001)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(voidRaf); voidRaf = null }
    else if (!voidRaf)   { voidRaf = requestAnimationFrame(drawVoidFrame) }
  })
  window.addEventListener('resize', () => {
    resizeVoidCanvas()
    gl.viewport(0, 0, voidCanvas.width, voidCanvas.height)
  }, { passive: true })

  voidRaf = requestAnimationFrame(drawVoidFrame)
}
