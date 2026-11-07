import * as THREE from 'three';
import { MARKER_COLOURS, SELECTED_COLOUR } from './materials';

/** One copy of an opening as the top of the cover shows it. */
export interface OpeningMarker {
  x: number;
  y: number;
  /** Its radius at the flat top: the seat's for a pour, the mouth's for a vent. */
  radius: number;
  kind: 'pour' | 'vent';
  valid: boolean;
}

/** A plain box between two corners, for the proxies T1 shows until T2's solids arrive. */
export interface BoxSpan {
  min: [number, number, number];
  max: [number, number, number];
}

const RING_WIDTH = 0.6;
/** Just above the flat top, so a ring is never buried in it. */
const LIFT = 0.05;

/**
 * Rings on the flat top for the openings: pour, vent and invalid. Dragging them is M8's; this only
 * shows where they are, for every copy across the grid.
 */
export class OpeningMarkers {
  readonly group = new THREE.Group();
  private readonly materials = {
    pour: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.pour, side: THREE.DoubleSide }),
    vent: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.vent, side: THREE.DoubleSide }),
    invalid: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.invalid, side: THREE.DoubleSide }),
  };

  constructor() {
    this.group.renderOrder = 3;
  }

  set(markers: OpeningMarker[], top: number): void {
    this.clear();
    for (const marker of markers) {
      const outer = marker.radius + RING_WIDTH / 2, inner = Math.max(0.1, marker.radius - RING_WIDTH / 2);
      const ring = new THREE.Mesh(new THREE.RingGeometry(inner, outer, 48), this.materials[marker.valid ? marker.kind : 'invalid']);
      ring.position.set(marker.x, marker.y, top + LIFT);
      ring.renderOrder = 3;
      this.group.add(ring);
    }
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.group.remove(child);
    }
  }
}

/** The 3D marks the Diagnostics card's Show toggle adds: a pin from above down to the point. */
export class DiagnosticMarkers {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ color: SELECTED_COLOUR, depthTest: false, transparent: true, opacity: 0.95 });

  set(points: [number, number, number][], size: number): void {
    for (const child of [...this.group.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.group.remove(child);
    }
    for (const [x, y, z] of points) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), this.material);
      head.position.set(x, y, z + size * 3);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.18, size * 0.18, size * 3, 8), this.material);
      stem.rotation.x = Math.PI / 2;
      stem.position.set(x, y, z + size * 1.5);
      for (const part of [head, stem]) {
        part.renderOrder = 20;
        this.group.add(part);
      }
    }
  }
}

/** A unit box moved and stretched onto a span, so one geometry serves every proxy. */
export function boxMesh(material: THREE.Material): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  return new THREE.Mesh(geometry, material);
}

export function placeBox(mesh: THREE.Mesh, span: BoxSpan | null): void {
  mesh.visible = span !== null;
  if (!span) return;
  const [x0, y0, z0] = span.min, [x1, y1, z1] = span.max;
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  mesh.scale.set(Math.max(x1 - x0, 1e-3), Math.max(y1 - y0, 1e-3), Math.max(z1 - z0, 1e-3));
}
