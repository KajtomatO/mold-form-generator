import * as THREE from 'three';

/** A part as the workers send it: positions, 3 per vertex, and triangles. */
export interface PartGeometry {
  positions: Float32Array;
  indices: Uint32Array;
}

export type PartName = 'cover' | 'base' | 'funnel';

/** The plan's part colours. The cover is see-through so the cavity shows. */
const PARTS: Record<PartName, { color: number; opacity: number }> = {
  cover: { color: 0xc7ccd3, opacity: 0.35 },
  base: { color: 0x6b7280, opacity: 1 },
  funnel: { color: 0x94a3b8, opacity: 1 },
};

export interface CameraView {
  position: [number, number, number];
  target: [number, number, number];
  /** Vertical field of view in degrees. */
  fov?: number;
}

/**
 * The 3D view: one scene, z up as in the mold's coordinates, a camera that can be set exactly, and the
 * parts the pipeline sends. M5 draws the cover and base; M6 adds the height preview, the model and the
 * controls on top of this.
 */
export class PreviewScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.1, 5000);
  private readonly target = new THREE.Vector3();
  private readonly meshes = new Map<PartName, THREE.Mesh>();
  private framed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x101418);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xe6ebf0, 0x303a45, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.6, -1, 1.4);
    this.scene.add(sun);
    this.resize();
  }

  resize(): void {
    const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.render();
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
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(part.indices, 1));
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      const { color, opacity } = PARTS[name];
      const material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0, transparent: opacity < 1, opacity, depthWrite: opacity === 1, side: THREE.DoubleSide });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.renderOrder = opacity < 1 ? 1 : 0;
      this.meshes.set(name, mesh);
      this.scene.add(mesh);
      if (!this.framed) this.frame();
    }
    this.render();
  }

  /** Looks at everything from the front, a little above, once the first part arrives. */
  frame(): void {
    const box = new THREE.Box3();
    this.meshes.forEach((mesh) => box.expandByObject(mesh));
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    this.setCamera({ position: [centre.x + size * 0.6, centre.y - size * 1.4, centre.z + size * 0.9], target: [centre.x, centre.y, centre.z] });
    this.framed = true;
  }

  setCamera(view: CameraView): void {
    this.camera.position.set(...view.position);
    this.target.set(...view.target);
    if (view.fov) this.camera.fov = view.fov;
    this.camera.lookAt(this.target);
    this.camera.updateProjectionMatrix();
    this.framed = true;
    this.render();
  }

  /** Where a point in mold coordinates lands on the page, in CSS pixels, for tests that click or drag in 3D. */
  worldToScreen(point: [number, number, number]): { x: number; y: number; visible: boolean } {
    const projected = new THREE.Vector3(...point).project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
      visible: Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1 && projected.z >= -1 && projected.z <= 1,
    };
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const name of [...this.meshes.keys()]) this.setPart(name, null);
    this.renderer.dispose();
  }
}
