import * as THREE from 'three';
import type { PreviewScene } from './scene';

/**
 * HB: frames a box from one fixed direction with the orthographic camera, as the help's explode animations are drawn
 * (src/diag/mediaPage.ts): this far round from the front and up from the bed, in degrees, the box filling the frame
 * of `aspect` (width over height) with `margin` to spare, centred.
 */
export function frameFixed(scene: PreviewScene, box: THREE.Box3, azimuthDeg: number, elevationDeg: number, aspect: number, margin: number): void {
  const az = THREE.MathUtils.degToRad(azimuthDeg), el = THREE.MathUtils.degToRad(elevationDeg);
  const back = new THREE.Vector3(Math.cos(el) * Math.sin(az), -Math.cos(el) * Math.cos(az), Math.sin(el));
  const right = new THREE.Vector3(0, 0, 1).cross(back).normalize(), up = new THREE.Vector3().crossVectors(back, right);
  const centre = box.getCenter(new THREE.Vector3());
  // The box's extent across and up the frame, about its centre.
  let across = 0, high = 0;
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const d = new THREE.Vector3(x, y, z).sub(centre);
    across = Math.max(across, Math.abs(d.dot(right)));
    high = Math.max(high, Math.abs(d.dot(up)));
  }
  const half = Math.max(high, across / aspect) * margin;
  const distance = half / Math.tan((scene.camera.fov * Math.PI) / 360);
  scene.setPerspective(false);
  scene.setCamera({ position: centre.clone().addScaledVector(back, distance).toArray(), target: centre.toArray() });
}
