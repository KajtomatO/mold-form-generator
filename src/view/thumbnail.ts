import * as THREE from 'three';
import { addViewLights, DEFAULT_LAYERS, partMaterial } from './materials';

/** The view: from the front right, this far round from the front and up from the bed, in degrees. */
const AZIMUTH_DEG = 35;
const ELEVATION_DEG = 28;
const FOV_DEG = 30;

/**
 * GA: draws a model's triangle soup as the view draws a model, with its material and lights (scene.ts), on a
 * transparent background at one fixed three-quarter view, `size` pixels square, and gives the picture as a WebP
 * data: URL. For the media page (src/diag/mediaPage.ts), which makes the gallery's thumbnails.
 */
export class ThumbnailRenderer {
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: THREE.WebGLRenderer;

  constructor(private readonly size: number) {
    this.canvas.width = this.canvas.height = size;
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    // Fixed at 1, so the picture has the same pixels whatever screen the page is on.
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.setClearColor(0x000000, 0);
  }

  draw(positions: Float32Array, quality = 0.9): string {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingSphere();
    const material = partMaterial('model', DEFAULT_LAYERS.model, false);
    const scene = new THREE.Scene();
    addViewLights(scene);
    scene.add(new THREE.Mesh(geometry, material));
    const { center, radius } = geometry.boundingSphere!;
    const camera = new THREE.PerspectiveCamera(FOV_DEG, 1, radius / 10, radius * 20);
    camera.up.set(0, 0, 1);
    // Far enough that the bounding sphere fills the frame with a small margin.
    const distance = (radius * 1.08) / Math.sin(THREE.MathUtils.degToRad(FOV_DEG / 2));
    const az = THREE.MathUtils.degToRad(AZIMUTH_DEG), el = THREE.MathUtils.degToRad(ELEVATION_DEG);
    camera.position.set(center.x + distance * Math.cos(el) * Math.sin(az), center.y - distance * Math.cos(el) * Math.cos(az), center.z + distance * Math.sin(el));
    camera.lookAt(center);
    this.renderer.render(scene, camera);
    const url = this.canvas.toDataURL('image/webp', quality);
    geometry.dispose();
    material.dispose();
    return url;
  }
}
