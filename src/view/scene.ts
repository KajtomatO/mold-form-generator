import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Field } from '../core/field/grid';
import { HeightPreview, type HeightMode } from './heightPreview';
import { applyStyle, DEFAULT_LAYERS, LAYER_COLOURS, LAYER_ORDER, partMaterial, type LayerName, type LayerStyle } from './materials';
import { boxMesh, DiagnosticMarkers, OpeningMarkers, placeBox, type BoxSpan, type MarkerSpec, type OpeningMarker } from './overlays';
import { Picker } from './picking';
import { SectionCaps, SectionHandle, type CapPart, type CapSource, type Counting } from './section';

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

/** S2's help for the model's cut: the triangles less the void shells, or null with none, and the air the plate seals. */
export interface ModelExtras {
  exterior: Uint32Array | null;
  /** `recesses` is null where S2 did not look, past the display proxy's limit. */
  sealedAir: { surface: PartGeometry | null; recesses: number | null };
}

/** A set of model triangles drawn over everything in one colour, for base confirmation. */
export interface Highlight {
  triangles: ArrayLike<number>;
  colour: number;
}

export const DARK_BACKGROUND = 0x101418;
export const LIGHT_BACKGROUND = 0xf2f4f7;

/** The section's plane: its normal points to the side kept, through `point`. */
export interface SectionPlane {
  normal: [number, number, number];
  point: [number, number, number];
}

/** How far each part moves in z in the exploded view, per mm of the slider: moved, never turned. */
export const EXPLODE = { cover: 1, base: -1, funnel: 2 } as const;

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
  readonly section: SectionCaps;
  readonly sectionHandle = new SectionHandle();
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
  /**
   * What the exploded view moves: the cover with its proxy and the opening rings on its top, the base
   * with its proxy, and the funnels. Plain objects, not groups, so the draw order inside stays as it was.
   */
  private readonly coverRoot = new THREE.Object3D();
  private readonly baseRoot = new THREE.Object3D();
  private readonly funnels = new THREE.Group();
  /** The model again at every other tile of a grid, sharing its geometry and material. */
  private readonly modelCopies = new THREE.Object3D();
  private tiles: [number, number][] = [[0, 0]];
  /** Whether the model's mesh is closed, which its cut and the silicone's need. Null until known. */
  private modelClosed: boolean | null = null;
  /** In Mode B the base on screen carries the model's copies, so exploded they go down with it. */
  private modelInBase = false;
  /** The real mesh's geometry for the section's count, when what is drawn is a lighter proxy. */
  private countedModel: { mesh: PartGeometry; geometry: THREE.BufferGeometry } | null = null;
  /**
   * What field.worker worked out at S2 for the model's cut (M11): the real mesh's triangles less its void
   * shells, which the silicone's count takes away, as no silicone reaches a hollow sealed inside the model,
   * such as the barrel's; and the air the plate seals under the model, such as Benchy's recessed lettering,
   * a closed surface in the file's coordinates, which it takes away too.
   */
  private extras: ModelExtras | null = null;
  /** Their geometries, built from those once each, the first time a cut needs them. */
  private exteriorModel: { indices: Uint32Array; geometry: THREE.BufferGeometry } | null = null;
  private sealedAir: { surface: PartGeometry; geometry: THREE.BufferGeometry } | null = null;
  /** The silicone's solid closed from below: the lattice's rectangle at z = 0, facing down. */
  private readonly siliconeFloor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
  /**
   * Where the cover's box takes that solid away, its height field and its floor: under coverRoot, so the
   * cavity goes up with the box in the exploded view while the silicone stays.
   */
  private readonly coverField = new THREE.Object3D();
  private readonly coverFloor = new THREE.Object3D();
  private readonly heightCounting: Record<1 | -1, Counting>;
  private explodeBy = 0;
  /** The mold's box, for the section's caps and handle and the top view. */
  private moldBox: THREE.Box3 | null = null;
  private markerTop = 0;
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
    this.renderer.localClippingEnabled = true;
    this.section = new SectionCaps(LAYER_COLOURS, this.renderer.getPixelRatio());
    this.heightCounting = this.section.counting(() => this.heights.stencilMaterial());
    this.modelGroup.matrixAutoUpdate = false;
    this.modelGroup.visible = false;
    this.modelGroup.add(this.highlights);
    this.modelCopies.visible = false;
    this.proxies = { cover: boxMesh(partMaterial('cover', this.styles.cover, false)), base: boxMesh(partMaterial('base', this.styles.base, false)) };
    this.proxies.cover.renderOrder = LAYER_ORDER.cover;
    for (const proxy of Object.values(this.proxies)) placeBox(proxy, null);
    this.coverRoot.add(this.proxies.cover, this.markers.group, this.coverField, this.coverFloor);
    this.baseRoot.add(this.proxies.base);
    // Faces down, so its outside is below: the field's solid is {0 <= z <= H}.
    this.siliconeFloor.rotation.x = Math.PI;
    this.siliconeFloor.visible = false;
    this.scene.add(this.modelGroup, this.modelCopies, this.heights.mesh, this.coverRoot, this.baseRoot, this.funnels, this.diagnosticMarkers.group, this.section.group, this.sectionHandle.group, this.siliconeFloor);

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
      old.removeFromParent();
      old.geometry.dispose();
      (old.material as THREE.Material).dispose();
      this.meshes.delete(name);
    }
    if (part) {
      const mesh = new THREE.Mesh(partGeometry(part), this.clip(partMaterial(name, this.styles[name], this.wireframe)));
      mesh.renderOrder = LAYER_ORDER[name];
      this.meshes.set(name, mesh);
      this.rootOf(name).add(mesh);
      if (!this.framed) this.frame();
    }
    this.requestRender();
  }

  /** Where a part hangs, so the exploded view moves it. A funnel set here, as no page does, stays put. */
  private rootOf(name: PartName): THREE.Object3D {
    return name === 'cover' ? this.coverRoot : name === 'base' ? this.baseRoot : this.scene;
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
      this.funnel = { geometry, material: this.clip(partMaterial('funnel', this.styles.funnel, this.wireframe)) };
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
    this.countedModel?.geometry.dispose();
    this.exteriorModel?.geometry.dispose();
    this.sealedAir?.geometry.dispose();
    this.countedModel = this.exteriorModel = this.sealedAir = null;
    if (display) {
      this.model = new THREE.Mesh(partGeometry(display), this.clip(partMaterial('model', this.styles.model, this.wireframe)));
      this.model.visible = !this.modelAway;
      this.modelGroup.add(this.model);
    }
    this.placeCopies();
    this.requestRender();
  }

  /** `matrix` takes the file's coordinates to the mold's, column by column, or is null before there is one. */
  setModelTransform(matrix: number[] | null): void {
    this.modelGroup.visible = matrix !== null;
    if (matrix) {
      this.modelGroup.matrix.fromArray(matrix);
      this.modelGroup.updateMatrixWorld(true);
    }
    this.placeCopies();
    this.requestRender();
  }

  /** The grid's tile offsets in mm, the first tile's at (0, 0): the model is drawn at every one. */
  setTiles(offsets: [number, number][]): void {
    this.tiles = offsets.length > 0 ? offsets : [[0, 0]];
    this.placeCopies();
    this.requestRender();
  }

  /** S2's extras for the model's cut, for the mesh set last, or null until they come. */
  setModelExtras(extras: ModelExtras | null): void {
    this.extras = extras;
    this.requestRender();
  }

  /** Whether the model's mesh is closed, as the import found: only a closed mesh gets a filled cut. */
  setModelClosed(closed: boolean | null): void {
    this.modelClosed = closed;
    this.requestRender();
  }

  /** Whether the base on screen holds the model's copies, as Mode B's merged base does. */
  setModelInBase(on: boolean): void {
    this.modelInBase = on;
    this.showModel();
  }

  /**
   * Exploded in Mode B, the model goes down with the base it is part of, and the base's own copy of it is
   * what shows; the one drawn on its own would stand in the silicone a second time. The silicone keeps a
   * hole where it was, as its count still takes the model away in place.
   */
  private get modelAway(): boolean {
    return this.modelInBase && this.explodeBy !== 0;
  }

  private showModel(): void {
    if (this.model) this.model.visible = !this.modelAway;
    this.modelCopies.visible = this.modelGroup.visible && !this.modelAway;
    this.requestRender();
  }

  /** The model at every tile but the first, which modelGroup holds with its highlights and picking. */
  private placeCopies(): void {
    this.modelCopies.clear();
    this.modelCopies.visible = this.modelGroup.visible && !this.modelAway;
    if (!this.model) return;
    for (const [ox, oy] of this.tiles.slice(1)) {
      const copy = new THREE.Mesh(this.model.geometry, this.model.material);
      copy.matrixAutoUpdate = false;
      copy.matrix.makeTranslation(ox, oy, 0).multiply(this.modelGroup.matrix);
      this.modelCopies.add(copy);
    }
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
        // Cut by the section like the model, so it never floats where the cut has taken the model away.
        const material = this.clip(new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.7, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
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
    this.markerTop = top;
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

  /** The mold's outer box, from the base's underside to the flat top, which the section and top view fit. */
  setMoldBox(min: [number, number, number] | null, max: [number, number, number] | null): void {
    this.moldBox = min && max ? new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)) : null;
    this.requestRender();
  }

  /** The cover and funnels up, the base down, by `distance` mm. Picking, the rings and the section follow. */
  setExplode(distance: number): void {
    this.explodeBy = distance;
    this.coverRoot.position.z = EXPLODE.cover * distance;
    this.baseRoot.position.z = EXPLODE.base * distance;
    this.funnels.position.z = EXPLODE.funnel * distance;
    this.showModel();
  }

  /** How far each part is moved in z now, for tests. */
  explodeOffsets(): { cover: number; base: number; funnel: number } {
    return { cover: this.coverRoot.position.z, base: this.baseRoot.position.z, funnel: this.funnels.position.z };
  }

  /** One clipping plane on every part, or null for none. Every material clips by the same Plane object. */
  setSection(section: SectionPlane | null): void {
    const was = this.section.on;
    this.section.on = section !== null;
    this.sectionHandle.group.visible = section !== null;
    if (section) this.section.plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(...section.normal), new THREE.Vector3(...section.point));
    if (was !== this.section.on) this.applyStyles();
    this.requestRender();
  }

  /** The parts whose cut was filled in the last frame drawn, for tests. */
  capParts(): CapPart[] {
    return this.section.on ? this.section.capped() : [];
  }

  /** Where each opening ring is, in mold coordinates, in the order set: ghosts of a drag's landing last. */
  markerPositions(): { x: number; y: number; valid: boolean; ghost: boolean }[] {
    return this.markers.positions();
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

  /** Looks straight down at the top, the whole box in view, so the openings can be placed by eye. */
  topView(): void {
    const box = this.moldBox;
    if (!box) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const half = Math.max(size.y / 2, size.x / 2 / this.camera.aspect) * 1.12;
    const distance = half / Math.tan((this.camera.fov * Math.PI) / 360);
    const top = box.max.z + EXPLODE.cover * this.explodeBy;
    // A hair to the front, so "up" on the screen stays +y and the orbit has a direction to start from.
    this.setCamera({ position: [centre.x, centre.y - distance * 1e-3, top + distance], target: [centre.x, centre.y, top] });
  }

  /** The ray under a point on the page. */
  private rayAt(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, this.active);
    return raycaster;
  }

  /** Where a point on the page meets the plane of the cover's flat top, in mold x and y, or null if it misses. */
  topPointAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const z = this.markerTop + this.coverRoot.position.z;
    const hit = this.rayAt(clientX, clientY).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), new THREE.Vector3());
    return hit ? { x: hit.x, y: hit.y } : null;
  }

  /** The opening ring under a point on the page, by its index in the list set, skipping rings the section cuts away. */
  markerAt(clientX: number, clientY: number): number | null {
    const at = this.topPointAt(clientX, clientY);
    if (!at) return null;
    const z = this.markerTop + this.coverRoot.position.z;
    const kept = (m: { x: number; y: number }): boolean => !this.section.on || this.section.plane.distanceToPoint(new THREE.Vector3(m.x, m.y, z)) >= 0;
    return kept(at) ? this.markers.hit(at.x, at.y, kept) : null;
  }

  /** Whether a point on the page is on the section's drag handle. */
  handleAt(clientX: number, clientY: number): boolean {
    return this.sectionHandle.hit(this.rayAt(clientX, clientY));
  }

  setHandleHot(on: boolean): void {
    if (this.sectionHandle.isHot === on) return;
    this.sectionHandle.setHot(on);
    this.requestRender();
  }

  /**
   * The point of the line through the handle along `axis` nearest to the ray under the pointer, as its
   * coordinate along that axis: where a drag of the handle puts the plane. Null when looking along it.
   */
  axisValueAt(clientX: number, clientY: number, axis: 0 | 1 | 2): number | null {
    const { ray } = this.rayAt(clientX, clientY);
    const along = new THREE.Vector3().setComponent(axis, 1);
    const origin = this.sectionHandle.group.position;
    const w0 = ray.origin.clone().sub(origin);
    const b = ray.direction.dot(along);
    const denominator = 1 - b * b;
    if (denominator < 1e-6) return null;
    const t = (along.dot(w0) - b * ray.direction.dot(w0)) / denominator;
    return origin.getComponent(axis) + t;
  }

  /** Orbit, pan and zoom on or off: off while a ring or the handle is dragged, so the camera does not move with it. */
  setControlsEnabled(on: boolean): void {
    if (this.controls) this.controls.enabled = on;
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

  /**
   * The model triangle under a point on the page, by its index in the real mesh, or null. With the
   * section on, the half it cut away is not there to pick, so the first hit on the side kept counts.
   */
  pickAt(clientX: number, clientY: number): number | null {
    if (!this.modelMesh || !this.modelGroup.visible) return null;
    const toWorld = this.modelGroup.matrixWorld;
    const local = this.rayAt(clientX, clientY).ray.clone().applyMatrix4(toWorld.clone().invert());
    const plane = this.section.on ? this.section.plane : null;
    const world = new THREE.Vector3();
    return this.picker.pick(local, plane ? (point) => plane.distanceToPoint(world.copy(point).applyMatrix4(toWorld)) >= 0 : undefined);
  }

  render(): void {
    this.drawQueued = false;
    if (this.section.on) {
      this.countCaps();
      // The counting meshes copy their sources' world matrices, so those must be current first.
      this.scene.updateMatrixWorld();
      const box = this.moldBox ?? new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(1, 1, 1));
      const centre = box.getCenter(new THREE.Vector3());
      const diagonal = box.getSize(new THREE.Vector3()).length();
      // Big enough for every part, wherever the exploded view has moved it.
      this.section.sync(centre, 3 * diagonal + 6 * Math.abs(this.explodeBy), this.active);
      this.sectionHandle.place(this.section.plane, centre, Math.max(1, diagonal * 0.08));
    }
    this.renderer.render(this.scene, this.active);
  }

  /**
   * What each part's cut is counted from, as the scene stands. A hidden part gets no cap, and nor do the
   * model and the silicone round it unless the model's mesh is closed: an open one has no inside to fill.
   */
  private countCaps(): void {
    const shows = (name: LayerName): boolean => this.styles[name].visible && this.styles[name].opacity > 0;
    const from = (object: THREE.Mesh | null | undefined, sign: 1 | -1 = 1): CapSource[] => (object && object.visible ? [{ geometry: object.geometry, object, sign }] : []);
    const closed = this.modelClosed === true && this.model !== null && this.modelGroup.visible;
    // The model's own cut is its whole mesh, so a hollow inside it shows as a hole; the silicone's takes
    // away the model with its hollows filled, as no silicone gets into them.
    const models = (sign: 1 | -1, filled: boolean): CapSource[] => {
      if (!closed) return [];
      const geometry = filled ? this.exteriorGeometry() : this.countedGeometry();
      return [this.model!, ...(this.modelCopies.children as THREE.Mesh[])].map((object) => ({ geometry, object, sign }));
    };
    // The preview's height field closed from below by the lattice's rectangle at z = 0: the solid the
    // silicone and the model fill together, where they stand or, for the cover's box, where the cover is.
    const span = this.heights.span();
    const field = (sign: 1 | -1, withCover = false): CapSource[] => {
      if (!span || !this.heights.mesh.visible) return [];
      const floor = this.siliconeFloor;
      floor.position.set((span.x0 + span.x1) / 2, (span.y0 + span.y1) / 2, 0);
      floor.scale.set(span.x1 - span.x0, span.y1 - span.y0, 1);
      this.coverFloor.position.copy(floor.position);
      this.coverFloor.quaternion.copy(floor.quaternion);
      this.coverFloor.scale.copy(floor.scale);
      return [
        { geometry: this.heights.mesh.geometry, object: withCover ? this.coverField : this.heights.mesh, sign, materials: this.heightCounting[sign] },
        { geometry: floor.geometry, object: withCover ? this.coverFloor : floor, sign },
      ];
    };
    const silicone = shows('silicone') && closed ? field(1) : [];
    if (silicone.length > 0) {
      silicone.push(...models(-1, true));
      const air = this.sealedGeometry();
      if (air) silicone.push(...[this.model!, ...(this.modelCopies.children as THREE.Mesh[])].map((object) => ({ geometry: air, object, sign: -1 as const })));
    }
    const solid = (name: 'cover' | 'base'): CapSource[] => {
      if (!shows(name)) return [];
      const built = this.meshes.get(name);
      if (built) return from(built);
      // A box stands in for the part until its solid is built on the rim on screen, as while t is
      // dragged. The cover's box has no cavity, so its cut is the box less the field's solid.
      const proxy = from(this.proxies[name]);
      return name === 'cover' && proxy.length > 0 ? [...proxy, ...field(-1, true)] : proxy;
    };
    this.section.setSources('silicone', silicone);
    this.section.setSources('model', shows('model') && !this.modelAway ? models(1, false) : []);
    this.section.setSources('base', solid('base'));
    this.section.setSources('cover', solid('cover'));
    this.section.setSources('funnel', shows('funnel') ? (this.funnels.children as THREE.Mesh[]).flatMap((copy) => from(copy)) : []);
  }

  /** The real mesh's geometry, which is closed where a lighter drawn proxy need not be. */
  private countedGeometry(): THREE.BufferGeometry {
    const mesh = this.modelMesh;
    if (!mesh || !this.model) throw new Error('No model to count.');
    if (this.model.geometry.getAttribute('position').array === mesh.positions) return this.model.geometry;
    if (this.countedModel?.mesh !== mesh) {
      this.countedModel?.geometry.dispose();
      this.countedModel = { mesh, geometry: partGeometry(mesh) };
    }
    return this.countedModel.geometry;
  }

  /** The real mesh less its void shells, built the first time a cut needs it. A mesh with no void serves as it is. */
  private exteriorGeometry(): THREE.BufferGeometry {
    const mesh = this.modelMesh, indices = this.extras?.exterior;
    if (!mesh) throw new Error('No model to count.');
    if (!indices) return this.countedGeometry();
    if (this.exteriorModel?.indices !== indices) {
      this.exteriorModel?.geometry.dispose();
      this.exteriorModel = { indices, geometry: partGeometry({ positions: mesh.positions, indices }) };
    }
    return this.exteriorModel.geometry;
  }

  /** The air the plate seals under the model, or null when there is none to take away. */
  private sealedGeometry(): THREE.BufferGeometry | null {
    const surface = this.extras?.sealedAir.surface;
    if (!surface) return null;
    if (this.sealedAir?.surface !== surface) {
      this.sealedAir?.geometry.dispose();
      this.sealedAir = { surface, geometry: partGeometry(surface) };
    }
    return this.sealedAir.geometry;
  }

  /** How many recesses the plate seals under the model, which the silicone's cut leaves out; null before S2 said, or where it did not look. */
  sealedRecesses(): number | null {
    return this.extras?.sealedAir.recesses ?? null;
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
    this.markers.dispose();
    this.section.dispose();
    this.sectionHandle.dispose();
    for (const { back, front } of Object.values(this.heightCounting)) {
      back.dispose();
      front.dispose();
    }
    this.siliconeFloor.geometry.dispose();
    this.controls?.dispose();
    this.renderer.dispose();
  }

  private applyStyles(): void {
    const { styles, wireframe } = this;
    this.meshes.forEach((mesh, name) => applyStyle(this.clip(mesh.material as THREE.Material), styles[name], wireframe));
    for (const name of ['cover', 'base'] as const) applyStyle(this.clip(this.proxies[name].material as THREE.Material), styles[name], wireframe);
    if (this.funnel) applyStyle(this.clip(this.funnel.material), styles.funnel, wireframe);
    if (this.model) applyStyle(this.clip(this.model.material as THREE.Material), styles.model, wireframe);
    this.heights.style(styles.silicone, wireframe);
    this.clip(this.heights.mesh.material);
    for (const material of Object.values(this.markers.materials)) this.clip(material);
    for (const child of this.highlights.children) this.clip((child as THREE.Mesh).material as THREE.Material);
    this.requestRender();
  }

  /** Every part clips by the section's one plane while it is on. */
  private clip<M extends THREE.Material>(material: M): M {
    material.clippingPlanes = this.section.on ? [this.section.plane] : null;
    return material;
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
