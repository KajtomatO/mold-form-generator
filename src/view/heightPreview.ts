import * as THREE from 'three';
import type { Field } from '../core/field/grid';
import { applyStyle, LAYER_COLOURS, LAYER_ORDER, type LayerStyle } from './materials';

/** How the heights reach the grid: a float texture read in the vertex shader, or attributes filled on the CPU. */
export type HeightMode = 'gpu' | 'cpu';

const VERTEX = /* glsl */ `
precision highp sampler2D;
uniform sampler2D heights;
// x0, y0 and the cell of the field's lattice.
uniform vec3 lattice;
#ifdef CPU_HEIGHTS
attribute float height;
attribute vec3 slope;
#endif
varying float vHeight;
varying vec3 vNormal;
#include <clipping_planes_pars_vertex>

#ifndef CPU_HEIGHTS
float heightAt(ivec2 ij) {
  ivec2 last = textureSize(heights, 0) - 1;
  return texelFetch(heights, clamp(ij, ivec2(0), last), 0).r;
}
#endif

void main() {
#ifdef CPU_HEIGHTS
  float h = height;
  vec3 n = slope;
#else
  ivec2 ij = ivec2(position.xy + 0.5);
  float h = heightAt(ij);
  // The surface is drawn trimmed at z = 0, so its slope comes from the trimmed heights too.
  float hl = max(heightAt(ij - ivec2(1, 0)), 0.0), hr = max(heightAt(ij + ivec2(1, 0)), 0.0);
  float hd = max(heightAt(ij - ivec2(0, 1)), 0.0), hu = max(heightAt(ij + ivec2(0, 1)), 0.0);
  vec3 n = vec3(hl - hr, hd - hu, 2.0 * lattice.z);
#endif
  // Outside the cavity a field may hold any negative value, and a varying must not interpolate an infinity.
  vHeight = max(h, -1.0);
  vNormal = n;
  vec3 world = vec3(lattice.x + position.x * lattice.z, lattice.y + position.y * lattice.z, max(h, 0.0));
  vec4 mvPosition = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <clipping_planes_vertex>
}`;

const FRAGMENT = /* glsl */ `
// A GLSL 3 shader names its own output; three's colour space chunk writes to gl_FragColor.
layout(location = 0) out highp vec4 fragColour;
#define gl_FragColor fragColour
uniform vec3 colour;
uniform float opacity;
varying float vHeight;
varying vec3 vNormal;
#include <clipping_planes_pars_fragment>

void main() {
  #include <clipping_planes_fragment>
#ifdef STENCIL_ONLY
  // The section's count of surfaces needs the whole closed height field, flat parts at z = 0 included.
  fragColour = vec4(0.0);
  return;
#endif
  // G7: the silicone is shown trimmed at z = 0, where the base plate closes it.
  if (vHeight <= 0.0) discard;
  vec3 n = normalize(vNormal);
  if (!gl_FrontFacing) n = -n;
  float sun = max(dot(n, normalize(vec3(0.35, -0.6, 0.72))), 0.0);
  float sky = 0.5 + 0.5 * n.z;
  gl_FragColor = vec4(colour * (0.3 + 0.4 * sky + 0.5 * sun), opacity);
  #include <colorspace_fragment>
}`;

/**
 * T1's silicone surface: the cavity ceiling H over a fixed grid of the field's nodes. On the GPU path
 * only the R32F texture changes when the field does; the grid is rebuilt only when the lattice grows or
 * shrinks. Where vertex textures are missing, the same material reads heights from attributes instead.
 */
export class HeightPreview {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly mode: HeightMode;
  private texture: THREE.DataTexture | null = null;
  private size = '';
  private field: Field | null = null;

  constructor(renderer: THREE.WebGLRenderer, forceCpu = false) {
    this.mode = !forceCpu && renderer.capabilities.maxVertexTextures > 0 ? 'gpu' : 'cpu';
    const material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: this.mode === 'cpu' ? { CPU_HEIGHTS: '' } : {},
      uniforms: {
        heights: { value: null },
        lattice: { value: new THREE.Vector3() },
        colour: { value: new THREE.Color(LAYER_COLOURS.silicone) },
        opacity: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: THREE.DoubleSide,
      clipping: true,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    // The vertices are lattice indices until the shader places them, so a computed bound would be wrong.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = LAYER_ORDER.silicone;
    this.mesh.visible = false;
  }

  set(field: Field | null): void {
    this.field = field;
    this.mesh.visible = field !== null;
    if (!field) return;
    const { nx, ny, cell, x0, y0 } = field;
    const material = this.mesh.material;
    material.uniforms.lattice.value.set(x0, y0, cell);
    const size = `${nx}x${ny}`;
    if (size !== this.size) {
      this.size = size;
      this.mesh.geometry.dispose();
      this.mesh.geometry = latticeGrid(nx, ny, this.mode === 'cpu');
    }
    if (this.mode === 'gpu') this.upload(field);
    else this.fill(field);
  }

  style(style: LayerStyle, wireframe: boolean): void {
    const material = this.mesh.material;
    applyStyle(material, style, wireframe);
    material.uniforms.opacity.value = style.opacity;
    this.mesh.visible = this.field !== null;
  }

  /**
   * The same surface for the section's stencil count, sharing the uniforms, so it follows every field.
   * Unlike the drawn one it keeps the flat parts at z = 0, which close the field's solid from above.
   */
  stencilMaterial(): THREE.ShaderMaterial {
    const shown = this.mesh.material;
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      defines: { ...shown.defines, STENCIL_ONLY: '' },
      uniforms: shown.uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      clipping: true,
    });
  }

  /** The rectangle the lattice spans in mm, which the section closes from below at z = 0. */
  span(): { x0: number; y0: number; x1: number; y1: number } | null {
    const f = this.field;
    return f ? { x0: f.x0, y0: f.y0, x1: f.x0 + (f.nx - 1) * f.cell, y1: f.y0 + (f.ny - 1) * f.cell } : null;
  }

  /** The node nearest a point in mm, for tests and markers: the height the preview draws there. */
  heightAt(x: number, y: number): number | null {
    const f = this.field;
    if (!f) return null;
    const i = Math.round((x - f.x0) / f.cell), j = Math.round((y - f.y0) / f.cell);
    if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) return null;
    return f.values[j * f.nx + i];
  }

  dispose(): void {
    this.texture?.dispose();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }

  private upload(field: Field): void {
    const { nx, ny, values } = field;
    const old = this.texture;
    if (old && old.image.width === nx && old.image.height === ny) {
      old.image.data = values;
      old.needsUpdate = true;
      return;
    }
    old?.dispose();
    const texture = new THREE.DataTexture(values, nx, ny, THREE.RedFormat, THREE.FloatType);
    texture.internalFormat = 'R32F';
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;
    this.texture = texture;
    this.mesh.material.uniforms.heights.value = texture;
  }

  /** The fallback: what the shader would read, written into the grid's attributes. */
  private fill(field: Field): void {
    const { nx, ny, cell, values } = field;
    const geometry = this.mesh.geometry;
    const heights = geometry.getAttribute('height') as THREE.BufferAttribute;
    const slopes = geometry.getAttribute('slope') as THREE.BufferAttribute;
    const h = heights.array as Float32Array, s = slopes.array as Float32Array;
    const at = (i: number, j: number): number => Math.max(values[Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i))], 0);
    for (let j = 0, n = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, n++) {
        h[n] = values[n];
        s[n * 3] = at(i - 1, j) - at(i + 1, j);
        s[n * 3 + 1] = at(i, j - 1) - at(i, j + 1);
        s[n * 3 + 2] = 2 * cell;
      }
    }
    heights.needsUpdate = true;
    slopes.needsUpdate = true;
  }
}

/** Vertices at (i, j) for every node, two triangles per square between them. */
function latticeGrid(nx: number, ny: number, cpu: boolean): THREE.BufferGeometry {
  const positions = new Float32Array(nx * ny * 3);
  for (let j = 0, n = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++, n += 3) {
      positions[n] = i;
      positions[n + 1] = j;
    }
  }
  const indices = new Uint32Array(Math.max(0, (nx - 1) * (ny - 1) * 6));
  for (let j = 0, k = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++, k += 6) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      indices.set([a, b, d, a, d, c], k);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  if (cpu) {
    geometry.setAttribute('height', new THREE.BufferAttribute(new Float32Array(nx * ny), 1));
    geometry.setAttribute('slope', new THREE.BufferAttribute(new Float32Array(nx * ny * 3), 3));
  }
  return geometry;
}
