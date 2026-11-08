import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Field } from '../core/field/grid';
import { HeightPreview, type HeightMode } from './heightPreview';
import { applyStyle, DEFAULT_LAYERS, LAYER_ORDER, partMaterial, type LayerName, type LayerStyle } from './materials';
import { boxMesh, DiagnosticMarkers, OpeningMarkers, placeBox, type BoxSpan, type MarkerSpec, type OpeningMarker } from './overlays';
import { Picker } from './picking';

/** A part as the workers send it: positions, 3 per vertex, and triangles. */
export interface PartGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

export type PartName = 'cover' | 'base' | 'funnel';

export interface CameraView {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view in degrees. */
  fov?: number;
}

export interface SceneOptions {
  /** Orbit controls, drawing on demand and every layer, as the app has them. The bare pipeline page keeps a fixed camera. */
  interactive?: boolean;
  /** The height preview's fallback path, even where vertex textures work, so a test can draw with it. */
  cpuHeights?: boolean;
}

/** A set of model triangles drawn over everything in one colour, for base confirmation. */
export interface Highlight {
  triangles: ArrayLike<number>;
  colour: number;
}

export const DARK_BACKGROUND = 0x101418;
export const LIGHT_BACKGROUND = 0xf2f4f7;

/**
 * The 3D view: one scene, z up as in the mold's coordinates, a camera that can be set exactly, and the
 * parts the pipeline sends. The app adds the model, the T1 height preview, box proxies, markers and
 * orbit controls on top of what the pipeline page uses.
 */
export class PreviewScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  readonly ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
  readonly heights: HeightPreview;
  readonly markers = new OpeningMarkers();
  readonly diagnosticMarkers = new DiagnosticMarkers();
  private active: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.camera;
  /**
   * What the view looks at. With orbit controls this is their own target, so a pan, which moves only
   * theirs, is what a toggle of the projection and the orthographic frustum build on.
   */
  private readonly target: THREE.Vector3;
  private readonly meshes = new Map<PartName, THREE.Mesh>();
  private readonly styles: Record<LayerName, LayerStyle> = structuredClone(DEFAULT_LAYERS);
  private wireframe = false;
  private framed = false;
  /** The model in its file's coordinates, under the base plane's rigid transform. */
  private readonly modelGroup = new THREE.Group();
  private model: THREE.Mesh | null = null;
  private modelMesh: PartGeometry | null = null;
  private readonly highlights = new THREE.Group();
  private readonly proxies: Record<'cover' | 'base', THREE.Mesh>;
  private readonly funnels = new THREE.Group();
  private funnel: { geometry: THREE.BufferGeometry; material: THREE.MeshStandardMaterial } | null = null;
  private readonly picker = new Picker();
  private readonly controls: OrbitControls | null = null;
  private drawQueued = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly options: SceneOptions = {},
  ) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(DARK_BACKGROUND);
    this.camera.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xe6ebf0, 0x303a45, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.6, -1, 1.4);
    this.scene.add(sun);

    this.heights = new HeightPreview(this.renderer, options.cpuHeights);
    this.modelGroup.matrixAutoUpdate = false;
    this.modelGroup.visible = false;
    this.modelGroup.add(this.highlights);
    this.proxies = { cover: boxMesh(partMaterial('cover', this.styles.cover, false)), base: boxMesh(partMaterial('base', this.styles.base, false)) };
    this.proxies.cover.renderOrder = LAYER_ORDER.cover;
    for (const proxy of Object.values(this.proxies)) placeBox(proxy, null);
    this.scene.add(this.modelGroup, this.heights.mesh, this.proxies.cover, this.proxies.base, this.funnels, this.markers.group, this.diagnosticMarkers.group);

    if (options.interactive) {
      this.controls = new OrbitControls(this.camera, canvas);
      this.controls.enableDamping = false;
      this.controls.addEventListener('change', () => this.requestRender());
    }
    this.target = this.controls?.target ?? new THREE.Vector3();
    this.resize();
  }

  get heightMode(): HeightMode {
    return this.heights.mode;
  }

  /** The renderer's own name, as the driver gives it: SwiftShader or llvmpipe mean drawing in software. */
  rendererName(): string {
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  }

  resize(): void {
    const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.fitOrtho();
    this.render();
  }

  setBackground(colour: number): void {
    (this.scene.background as THREE.Color).set(colour);
    this.requestRender();
  }

  /** Replaces a part, freeing the GPU buffers of the old one, as each rebuild sends a new mesh. */
  setPart(name: PartName, part: PartGeometry | null): void {
    const old = this.meshes.get(name);
    if (old) {
      this.scene.remove(old);
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
      this.meshes.delete(name);
    }
    if (part) {
      const mesh = new THREE.Mesh(partGeometry(part), partMaterial(name, this.styles[name], this.wireframe));
      mesh.renderOrder = LAYER_ORDER[name];
      this.meshes.set(name, mesh);
      this.scene.add(mesh);
      if (!this.framed) this.frame();
    }
    this.requestRender();
  }

  /** Shows a box in place of a part until its solid arrives: the cover's outer box, the base's plate. */
  setProxy(name: 'cover' | 'base', span: BoxSpan | null): void {
    placeBox(this.proxies[name], span);
    this.requestRender();
  }

  /** The funnel, one copy seated at each pour. Its own z = 0 is the cover's flat top. */
  setFunnel(part: PartGeometry | null, spots: [number, number, number][]): void {
    if (this.funnel && (!part || this.funnel.geometry.userData.source !== part)) {
      this.funnel.geometry.dispose();
      this.funnel.material.dispose();
      this.funnel = null;
    }
    if (part && !this.funnel) {
      const geometry = partGeometry(part);
      geometry.userData.source = part;
      this.funnel = { geometry, material: partMaterial('funnel', this.styles.funnel, this.wireframe) };
    }
    this.funnels.clear();
    if (this.funnel) {
      for (const [x, y, z] of spots) {
        const copy = new THREE.Mesh(this.funnel.geometry, this.funnel.material);
        copy.position.set(x, y, z);
        this.funnels.add(copy);
      }
    }
    this.requestRender();
  }

  /**
   * The model: `mesh` is the real one, which picking and highlights use; `display` is what is drawn,
   * which above 300k triangles is a lighter proxy. Both are in the file's coordinates.
   */
  setModel(mesh: PartGeometry | null, display: PartGeometry | null = mesh): void {
    if (this.model) {
      this.modelGroup.remove(this.model);
      this.model.geometry.dispose();
      (this.model.material as THREE.Material).dispose();
      this.model = null;
    }
    this.modelMesh = mesh;
    this.picker.setMesh(mesh);
    this.setHighlights([]);
    if (display) {
      this.model = new THREE.Mesh(partGeometry(display), partMaterial('model', this.styles.model, this.wireframe));
      this.modelGroup.add(this.model);
    }
    this.requestRender();
  }

  /** The base plane's rigid transform, column-major, or null before there is one. */
  setModelTransform(matrix: number[] | null): void {
    this.modelGroup.visible = matrix !== null;
    if (matrix) {
      this.modelGroup.matrix.fromArray(matrix);
      this.modelGroup.updateMatrixWorld(true);
    }
    this.requestRender();
  }

  setHighlights(sets: Highlight[]): void {
    for (const child of [...this.highlights.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
      this.highlights.remove(mesh);
    }
    const mesh = this.modelMesh;
    if (mesh) {
      const position = new THREE.BufferAttribute(mesh.positions, 3);
      for (const { triangles, colour } of sets) {
        if (triangles.length === 0) continue;
        const index = new Uint32Array(triangles.length * 3);
        for (let k = 0; k < triangles.length; k++) index.set(mesh.indices.subarray(triangles[k] * 3, triangles[k] * 3 + 3), k * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', position);
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
        // Over everything: the face to stand on is usually underneath, behind the base and the silicone.
        const material = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        const highlight = new THREE.Mesh(geometry, material);
        highlight.renderOrder = 10;
        this.highlights.add(highlight);
      }
    }
    this.requestRender();
  }

  /** How many triangles each highlight shows, for tests. */
  highlightCounts(): number[] {
    return this.highlights.children.map((child) => ((child as THREE.Mesh).geometry.index?.count ?? 0) / 3);
  }

  /** The box a proxy stands in for, or null while it is hidden, for tests. */
  proxySpan(name: 'cover' | 'base'): BoxSpan | null {
    const { visible, position: p, scale: s } = this.proxies[name];
    return visible ? { min: [p.x - s.x / 2, p.y - s.y / 2, p.z - s.z / 2], max: [p.x + s.x / 2, p.y + s.y / 2, p.z + s.z / 2] } : null;
  }

  /** Whether each part draws, and how see-through, as the objects that draw it now have it, for tests. */
  partStyles(): Record<LayerName, LayerStyle | null> {
    const of = (object: THREE.Object3D | null | undefined, material: THREE.Material | undefined): LayerStyle | null =>
      object && material ? { visible: object.visible && material.visible, opacity: material.opacity } : null;
    const solid = (name: 'cover' | 'base'): LayerStyle | null => {
      const mesh = this.meshes.get(name) ?? (this.proxies[name].visible ? this.proxies[name] : null);
      return of(mesh, mesh?.material as THREE.Material | undefined);
    };
    return {
      model: of(this.model, this.model?.material as THREE.Material | undefined),
      silicone: of(this.heights.mesh, this.heights.mesh.material),
      cover: solid('cover'),
      base: solid('base'),
      funnel: of(this.funnels.children[0], this.funnel?.material),
    };
  }

  setField(field: Field | null): void {
    this.heights.set(field);
    this.requestRender();
  }

  setOpenings(markers: OpeningMarker[], top: number): void {
    this.markers.set(markers, top);
    this.requestRender();
  }

  setDiagnosticMarkers(marks: MarkerSpec[], size: number): void {
    this.diagnosticMarkers.set(marks, size);
    this.requestRender();
  }

  setLayer(name: LayerName, style: LayerStyle): void {
    this.styles[name] = { ...style };
    this.applyStyles();
  }

  setWireframe(on: boolean): void {
    this.wireframe = on;
    this.applyStyles();
  }

  /** Perspective or orthographic, keeping what the view looks at and how large it appears. */
  setPerspective(on: boolean): void {
    const wanted = on ? this.camera : this.ortho;
    if (wanted === this.active) return;
    const fovTan = Math.tan((this.camera.fov * Math.PI) / 360);
    if (on) {
      // The distance at which the perspective camera shows the height the orthographic one did.
      const height = (this.ortho.top - this.ortho.bottom) / this.ortho.zoom;
      const direction = new THREE.Vector3().subVectors(this.ortho.position, this.target).normalize();
      this.camera.position.copy(this.target).addScaledVector(direction, height / (2 * fovTan));
      this.camera.lookAt(this.target);
    } else {
      this.ortho.position.copy(this.camera.position);
      this.ortho.zoom = 1;
      this.ortho.lookAt(this.target);
    }
    this.active = wanted;
    this.fitOrtho();
    if (this.controls) {
      this.controls.object = wanted;
      this.controls.update();
    }
    this.render();
  }

  get perspective(): boolean {
    return this.active === this.camera;
  }

  /** Looks at everything from the front, a little above, once the first part arrives. */
  frame(): void {
    const box = new THREE.Box3();
    this.meshes.forEach((mesh) => box.expandByObject(mesh));
    if (box.isEmpty()) return;
    this.frameBox(box.min.toArray(), box.max.toArray());
  }

  frameBox(min: [number, number, number] | number[], max: [number, number, number] | number[]): void {
    const box = new THREE.Box3(new THREE.Vector3().fromArray(min), new THREE.Vector3().fromArray(max));
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.setCamera({ position: [centre.x + size * 0.6, centre.y - size * 1.4, centre.z + size * 0.9], target: [centre.x, centre.y, centre.z] });
  }

  setCamera(view: CameraView): void {
    if (view.fov) this.camera.fov = view.fov;
    this.target.set(...view.target);
    for (const camera of [this.camera, this.ortho]) {
      camera.position.set(...view.position);
      camera.lookAt(this.target);
    }
    this.ortho.zoom = 1;
    this.camera.updateProjectionMatrix();
    this.fitOrtho();
    this.controls?.update();
    this.framed = true;
    this.render();
  }

  /** Where a point in mold coordinates lands on the page, in CSS pixels, for tests that click or drag in 3D. */
  worldToScreen(point: [number, number, number]): { x: number; y: number; visible: boolean } {
    const projected = new THREE.Vector3(...point).project(this.active);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
      visible: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z >= -1 && projected.z <= 1,
    };
  }

  /** The model triangle under a point on the page, by its index in the real mesh, or null. */
  pickAt(clientX: number, clientY: number): number | null {
    if (!this.modelMesh || !this.modelGroup.visible) return null;
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.active);
    const local = raycaster.ray.clone().applyMatrix4(this.modelGroup.matrixWorld.clone().invert());
    return this.picker.pick(local);
  }

  render(): void {
    this.drawQueued = false;
    this.renderer.render(this.scene, this.active);
  }

  /** Draws once on the next frame, however many changes come before it. The bare page draws at once. */
  requestRender(): void {
    if (!this.options.interactive) {
      this.render();
      return;
    }
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      if (this.drawQueued) this.render();
    });
  }

  dispose(): void {
    for (const name of [...this.meshes.keys()]) this.setPart(name, null);
    this.setModel(null);
    this.setFunnel(null, []);
    this.heights.dispose();
    this.markers.clear();
    this.controls?.dispose();
    this.renderer.dispose();
  }

  private applyStyles(): void {
    const { styles, wireframe } = this;
    this.meshes.forEach((mesh, name) => applyStyle(mesh.material as THREE.Material, styles[name], wireframe));
    for (const name of ['cover', 'base'] as const) applyStyle(this.proxies[name].material as THREE.Material, styles[name], wireframe);
    if (this.funnel) applyStyle(this.funnel.material, styles.funnel, wireframe);
    if (this.model) applyStyle(this.model.material as THREE.Material, styles.model, wireframe);
    this.heights.style(styles.silicone, wireframe);
    this.requestRender();
  }

  /** The orthographic frustum that shows at the target what the perspective camera shows there. */
  private fitOrtho(): void {
    const distance = this.ortho.position.distanceTo(this.target) || 1;
    const half = distance * Math.tan((this.camera.fov * Math.PI) / 360);
    this.ortho.top = half;
    this.ortho.bottom = -half;
    this.ortho.left = -half * this.camera.aspect;
    this.ortho.right = half * this.camera.aspect;
    this.ortho.updateProjectionMatrix();
  }
}

function partGeometry(part: PartGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
