import * as THREE from 'three';

export interface GlProbeResult {
  webgl2: boolean;
  renderer: string;
  stencilBits: number;
  distinctColours: number;
  error: string | null;
}

/**
 * Proves the preview technique works here: a float height texture read with texelFetch
 * in a vertex shader, displacing a fixed grid. Leaves the image on the canvas.
 */
export function probeGl(canvas: HTMLCanvasElement): GlProbeResult {
  const result: GlProbeResult = { webgl2: false, renderer: '', stencilBits: 0, distinctColours: 0, error: null };
  try {
    const renderer = new THREE.WebGLRenderer({ canvas, stencil: true, antialias: false, preserveDrawingBuffer: true });
    const gl = renderer.getContext();
    result.webgl2 = gl instanceof WebGL2RenderingContext;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    result.renderer = String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
    result.stencilBits = gl.getParameter(gl.STENCIL_BITS) as number;

    const size = 64;
    const heights = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        heights[x + y * size] = Math.sin(x * 0.2) * Math.cos(y * 0.15) * 0.5 + 0.5;
      }
    }
    const texture = new THREE.DataTexture(heights, size, size, THREE.RedFormat, THREE.FloatType);
    texture.internalFormat = 'R32F';
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;

    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        heightTex: { value: texture },
        projectionMatrix: { value: new THREE.Matrix4() },
        modelViewMatrix: { value: new THREE.Matrix4() },
      },
      vertexShader: `
        precision highp float;
        precision highp sampler2D;
        uniform sampler2D heightTex;
        uniform mat4 projectionMatrix;
        uniform mat4 modelViewMatrix;
        in vec3 position;
        in vec2 uv;
        out float vHeight;
        void main() {
          ivec2 size = textureSize(heightTex, 0);
          ivec2 ij = ivec2(uv * vec2(size - 1) + 0.5);
          vHeight = texelFetch(heightTex, ij, 0).r;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, vHeight, 1.0);
        }`,
      fragmentShader: `
        precision highp float;
        in float vHeight;
        out vec4 colour;
        void main() { colour = vec4(vHeight, 0.4, 1.0 - vHeight, 1.0); }`,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6, size - 1, size - 1), material);
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -5, 5);
    camera.updateMatrixWorld();
    mesh.updateMatrixWorld();
    material.uniforms.projectionMatrix.value.copy(camera.projectionMatrix);
    material.uniforms.modelViewMatrix.value.copy(mesh.matrixWorld);
    renderer.render(scene, camera);

    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const colours = new Set<number>();
    for (let i = 0; i < pixels.length; i += 4) {
      colours.add((pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2]);
    }
    result.distinctColours = colours.size;
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR) result.error = `GL error ${glError}`;
  } catch (error) {
    result.error = String(error);
  }
  return result;
}
