import * as THREE from 'three';

/** The parts a section cut fills, each in its own colour. */
export type CapPart = 'silicone' | 'model' | 'base' | 'cover' | 'funnel';

/** In draw order. The silicone's count takes the model away, so no two caps share a pixel. */
export const CAP_PARTS: readonly CapPart[] = ['silicone', 'model', 'base', 'cover', 'funnel'];

/** One closed surface that counts towards a part's cut. */
export interface CapSource {
  geometry: THREE.BufferGeometry;
  /** Drawn with this object's world matrix, so it follows the part wherever it is moved. */
  object: THREE.Object3D;
  /** -1 for a solid taken out of the part, such as the model out of the silicone round it. */
  sign: 1 | -1;
  /** For geometry a shader places, such as the height field: its own counting materials. */
  materials?: Counting;
}

/** The two passes of a count: back faces add the source's sign, front faces take it away. */
export interface Counting {
  back: THREE.Material;
  front: THREE.Material;
}

/** Hatch per part, as the direction across its lines: the model's run the other way to the plastic's. */
const HATCH: Record<CapPart, [number, number]> = {
  silicone: [0, 1],
  model: [-Math.SQRT1_2, Math.SQRT1_2],
  base: [Math.SQRT1_2, Math.SQRT1_2],
  cover: [Math.SQRT1_2, Math.SQRT1_2],
  funnel: [1, 0],
};

/** CSS pixels between hatch lines, and the share of that taken by a line. */
const HATCH_SPACING = 9;
const HATCH_LINE = 0.25;
/** How much darker a hatch line is than its cap, in linear light. */
const HATCH_SHADE = 0.62;

/** All the section's own draws come after every other opaque draw: they read the depth those left. */
const SECTION_GROUP_ORDER = 50;

const CAP_VERTEX = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const CAP_FRAGMENT = /* glsl */ `
layout(location = 0) out highp vec4 fragColour;
#define gl_FragColor fragColour
uniform vec3 colour;
// Across the hatch lines, and their period, in device pixels.
uniform vec2 hatch;
uniform float spacing;
uniform float shade;

void main() {
  float along = mod(dot(gl_FragCoord.xy, hatch), spacing);
  float line = along < spacing * ${HATCH_LINE.toFixed(2)} ? 1.0 : 0.0;
  gl_FragColor = vec4(colour * mix(1.0, shade, line), 1.0);
  #include <colorspace_fragment>
}`;

/**
 * Sets a material up as one pass of a count, after the stencil technique of three.js's MIT-licensed
 * webgl_clipping_stencil example, written here from its idea: every face of a part's closed surface
 * that the plane leaves is drawn with no depth test and no colour, back faces adding to the stencil
 * and front faces taking away. Along the ray to a point of the plane, that leaves the part's winding
 * number there, so its cap is drawn where that is not 0.
 */
function setCounting(material: THREE.Material, plane: THREE.Plane, side: THREE.Side, op: THREE.StencilOp): void {
  material.side = side;
  material.colorWrite = false;
  material.depthWrite = false;
  material.depthTest = false;
  material.stencilWrite = true;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilFail = op;
  material.stencilZFail = op;
  material.stencilZPass = op;
  material.clippingPlanes = [plane];
}

/** How a source of each sign counts: back faces add the sign, front faces take it away. */
const PASSES: Record<1 | -1, [THREE.Side, THREE.StencilOp][]> = {
  1: [[THREE.BackSide, THREE.IncrementWrapStencilOp], [THREE.FrontSide, THREE.DecrementWrapStencilOp]],
  [-1]: [[THREE.BackSide, THREE.DecrementWrapStencilOp], [THREE.FrontSide, THREE.IncrementWrapStencilOp]],
} as Record<1 | -1, [THREE.Side, THREE.StencilOp][]>;

interface PartEntry {
  sources: CapSource[];
  meshes: THREE.Mesh[];
  cap: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
}

/**
 * The section view's filled cuts: one clipping plane for every part, and on it a cap per closed part
 * in that part's colour, with a hatch of our own. Each part's count runs and its cap is drawn before
 * the next part's count starts, and the cap leaves the stencil at 0 behind it.
 */
export class SectionCaps {
  readonly plane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  readonly group = new THREE.Group();
  private readonly entries = new Map<CapPart, PartEntry>();
  private readonly plain: Record<1 | -1, Counting>;
  private readonly capGeometry = new THREE.PlaneGeometry(1, 1);

  constructor(colours: Record<CapPart, number>, pixelRatio: number) {
    this.group.renderOrder = SECTION_GROUP_ORDER;
    this.group.visible = false;
    this.plain = this.counting(() => new THREE.MeshBasicMaterial());
    CAP_PARTS.forEach((part, k) => {
      // The silicone counts the model as taken away, so only where the count is exactly 1 is silicone;
      // a part on its own is wherever its winding is not 0.
      const silicone = part === 'silicone';
      const material = new THREE.ShaderMaterial({
        glslVersion: THREE.GLSL3,
        uniforms: {
          colour: { value: new THREE.Color(colours[part]) },
          hatch: { value: new THREE.Vector2(...HATCH[part]) },
          spacing: { value: HATCH_SPACING * pixelRatio },
          shade: { value: HATCH_SHADE },
        },
        vertexShader: CAP_VERTEX,
        fragmentShader: CAP_FRAGMENT,
        side: THREE.DoubleSide,
        // All caps lie on the same plane at the same depth. Should two parts' counts ever cover the same
        // pixel, as a box standing in for a part might, the part drawn first keeps it.
        depthFunc: THREE.LessDepth,
        stencilWrite: true,
        stencilRef: silicone ? 1 : 0,
        stencilFunc: silicone ? THREE.EqualStencilFunc : THREE.NotEqualStencilFunc,
        // Wherever the cap reaches, the stencil goes back to 0 for the next part.
        stencilFail: THREE.ZeroStencilOp,
        stencilZFail: THREE.ZeroStencilOp,
        stencilZPass: THREE.ZeroStencilOp,
      });
      const cap = new THREE.Mesh(this.capGeometry, material);
      cap.renderOrder = 2 * k + 1;
      cap.frustumCulled = false;
      // A count that strayed past the cap's square would otherwise reach the next part's.
      cap.onAfterRender = (renderer) => renderer.clearStencil();
      this.group.add(cap);
      this.entries.set(part, { sources: [], meshes: [], cap });
    });
  }

  /**
   * Counting materials for each sign, from `make`, which gives a fresh material of the right shader:
   * plain for a mesh, or the source's own for geometry a shader places.
   */
  counting(make: () => THREE.Material): Record<1 | -1, Counting> {
    const pair = (sign: 1 | -1): Counting => {
      const [back, front] = PASSES[sign].map(([side, op]) => {
        const material = make();
        setCounting(material, this.plane, side, op);
        return material;
      });
      return { back, front };
    };
    return { 1: pair(1), [-1]: pair(-1) } as Record<1 | -1, Counting>;
  }

  get on(): boolean {
    return this.group.visible;
  }

  set on(value: boolean) {
    this.group.visible = value;
  }

  /**
   * What each part's cut is counted from now. An empty list means no cap, such as for a hidden part or
   * a model whose mesh is not closed. Counting meshes are made again only when the list changes.
   */
  setSources(part: CapPart, sources: CapSource[]): void {
    const entry = this.entries.get(part)!;
    const same = entry.sources.length === sources.length && entry.sources.every((s, k) => s.geometry === sources[k].geometry && s.object === sources[k].object && s.sign === sources[k].sign && s.materials === sources[k].materials);
    if (same) return;
    for (const mesh of entry.meshes) this.group.remove(mesh);
    entry.sources = sources;
    entry.meshes = [];
    const order = CAP_PARTS.indexOf(part) * 2;
    for (const source of sources) {
      const own = source.materials;
      const { back, front } = own ?? this.plain[source.sign];
      for (const material of [back, front]) {
        const mesh = new THREE.Mesh(source.geometry, material);
        mesh.matrixAutoUpdate = false;
        mesh.renderOrder = order;
        // The height field's vertices are lattice indices until its shader places them.
        mesh.frustumCulled = !own;
        this.group.add(mesh);
        entry.meshes.push(mesh);
      }
    }
    entry.cap.visible = sources.length > 0;
  }

  /** Which parts get a filled cut, as last set. */
  capped(): CapPart[] {
    return CAP_PARTS.filter((part) => this.entries.get(part)!.sources.length > 0);
  }

  /**
   * Before each draw: every counting mesh takes its source's world matrix, and the caps lie on the plane
   * as squares of `size` round the point of it nearest `centre`. Call after the scene's matrices are current.
   */
  sync(centre: THREE.Vector3, size: number, camera: THREE.Camera): void {
    if (!this.on) return;
    // Seen from the side kept, a ray reaches the plane through a part's front faces, so every count comes
    // out negated, and the silicone's "exactly 1" reads -1, which the 8-bit stencil wraps to 255. The
    // other caps ask only for "not 0", which holds either way.
    this.entries.get('silicone')!.cap.material.stencilRef = viewsFromKeptSide(this.plane, camera) ? 0xff : 1;
    const at = this.plane.projectPoint(centre, new THREE.Vector3());
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal);
    for (const entry of this.entries.values()) {
      entry.sources.forEach((source, k) => {
        for (const mesh of entry.meshes.slice(2 * k, 2 * k + 2)) mesh.matrix.copy(source.object.matrixWorld);
      });
      entry.cap.position.copy(at);
      entry.cap.quaternion.copy(turn);
      entry.cap.scale.set(size, size, 1);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.cap.material.dispose();
    for (const { back, front } of Object.values(this.plain)) {
      back.dispose();
      front.dispose();
    }
    this.capGeometry.dispose();
  }
}

/**
 * Whether the camera looks at the plane from the side it keeps. A perspective camera's rays all start at
 * its position; an orthographic one's start far behind it, at its near plane, so only its direction counts.
 */
function viewsFromKeptSide(plane: THREE.Plane, camera: THREE.Camera): boolean {
  if (camera instanceof THREE.OrthographicCamera) return camera.getWorldDirection(new THREE.Vector3()).dot(plane.normal) < 0;
  return plane.distanceToPoint(camera.getWorldPosition(new THREE.Vector3())) > 0;
}

/** How much wider the handle's dark rim is than each of its parts, in the handle's own units. */
const HANDLE_RIM = 0.035;

/**
 * The section's drag handle: a ball on the plane with an arrow each way along its normal. A dark rim round
 * each part keeps it readable on the light cover cap and on the light theme's background.
 */
export class SectionHandle {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ color: 0xe6ebf0, depthTest: false, transparent: true, opacity: 0.95 });
  private readonly hot = new THREE.MeshBasicMaterial({ color: 0xfacc15, depthTest: false, transparent: true, opacity: 0.95 });
  private readonly rim = new THREE.MeshBasicMaterial({ color: 0x101418, depthTest: false, transparent: true, opacity: 0.9 });
  private readonly parts: THREE.Mesh[] = [];
  private readonly rims: THREE.Mesh[] = [];

  constructor() {
    // A unit handle along +z, scaled to the mold and turned onto the plane's normal. Each part has a
    // slightly larger dark copy drawn just before it, which shows only as a rim round its edge.
    const add = (make: (grow: number) => THREE.BufferGeometry, place: (mesh: THREE.Mesh) => void): void => {
      const part = new THREE.Mesh(make(0), this.material);
      const rim = new THREE.Mesh(make(HANDLE_RIM), this.rim);
      for (const mesh of [part, rim]) place(mesh);
      part.renderOrder = 25;
      rim.renderOrder = 24;
      this.parts.push(part);
      this.rims.push(rim);
      this.group.add(rim, part);
    };
    add((grow) => new THREE.SphereGeometry(0.16 + grow, 20, 14), () => undefined);
    add((grow) => new THREE.CylinderGeometry(0.035 + grow, 0.035 + grow, 1.3, 10), (mesh) => (mesh.rotation.x = Math.PI / 2));
    for (const end of [1, -1]) {
      add(
        (grow) => new THREE.ConeGeometry(0.12 + 1.5 * grow, 0.3 + 2 * grow, 16),
        (mesh) => {
          mesh.rotation.x = end * (Math.PI / 2);
          mesh.position.z = end * 0.75;
        },
      );
    }
    this.group.visible = false;
  }

  /** On the plane at the point nearest `centre`, sized to the mold. */
  place(plane: THREE.Plane, centre: THREE.Vector3, size: number): void {
    plane.projectPoint(centre, this.group.position);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), plane.normal);
    this.group.scale.setScalar(size);
  }

  /** Yellow while the pointer is over it or drags it, as yellow means what the pointer is on. */
  setHot(on: boolean): void {
    for (const part of this.parts) part.material = on ? this.hot : this.material;
  }

  get isHot(): boolean {
    return this.parts[0].material === this.hot;
  }

  /** The rims are a little wider than the parts, so a press on one takes the handle too. */
  hit(raycaster: THREE.Raycaster): boolean {
    return this.group.visible && raycaster.intersectObjects(this.rims, false).length > 0;
  }

  dispose(): void {
    for (const mesh of [...this.parts, ...this.rims]) mesh.geometry.dispose();
    this.material.dispose();
    this.hot.dispose();
    this.rim.dispose();
  }
}
