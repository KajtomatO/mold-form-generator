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
  /** Where a dragged opening would land if let go now, faint, and not something a press can grab. */
  ghost?: boolean;
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
 * Rings on the flat top for the openings, pour, vent and invalid, for every copy across the grid. A
 * drag sets them again on every pointer move, so rings of one radius share one geometry.
 */
export class OpeningMarkers {
  readonly group = new THREE.Group();
  readonly materials = {
    pour: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.pour, side: THREE.DoubleSide }),
    vent: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.vent, side: THREE.DoubleSide }),
    invalid: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.invalid, side: THREE.DoubleSide }),
    pourGhost: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.pour, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false }),
    ventGhost: new THREE.MeshBasicMaterial({ color: MARKER_COLOURS.vent, side: THREE.DoubleSide, transparent: true, opacity: 0.5, depthWrite: false }),
  };
  private readonly rings = new Map<number, THREE.RingGeometry>();
  private markers: OpeningMarker[] = [];

  constructor() {
    this.group.renderOrder = 3;
  }

  set(markers: OpeningMarker[], top: number): void {
    this.clear();
    this.markers = markers;
    for (const marker of markers) {
      const material = marker.ghost ? this.materials[`${marker.kind}Ghost`] : this.materials[marker.valid ? marker.kind : 'invalid'];
      const ring = new THREE.Mesh(this.ring(marker.radius), material);
      ring.position.set(marker.x, marker.y, top + LIFT);
      ring.renderOrder = 3;
      this.group.add(ring);
    }
  }

  /**
   * The marker a point of the top falls on, by its index in the list last set, or null. The whole disc
   * inside a ring counts, as a vent's ring is small to hit; where two overlap, the nearer centre wins.
   */
  hit(x: number, y: number, keep: (marker: OpeningMarker) => boolean = () => true): number | null {
    let best: number | null = null, nearest = Infinity;
    this.markers.forEach((marker, k) => {
      const d = Math.hypot(x - marker.x, y - marker.y);
      if (!marker.ghost && d <= marker.radius + RING_WIDTH && d < nearest && keep(marker)) {
        best = k;
        nearest = d;
      }
    });
    return best;
  }

  /** Where each ring is now, in the order set, for tests. */
  positions(): { x: number; y: number; valid: boolean; ghost: boolean }[] {
    return this.markers.map(({ x, y, valid, ghost }) => ({ x, y, valid, ghost: ghost === true }));
  }

  clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    this.markers = [];
  }

  dispose(): void {
    this.clear();
    for (const ring of this.rings.values()) ring.dispose();
    this.rings.clear();
  }

  private ring(radius: number): THREE.RingGeometry {
    let ring = this.rings.get(radius);
    if (!ring) {
      // A size change makes new radii, and the old ones are not coming back.
      if (this.rings.size > 8) {
        for (const old of this.rings.values()) old.dispose();
        this.rings.clear();
      }
      ring = new THREE.RingGeometry(Math.max(0.1, radius - RING_WIDTH / 2), radius + RING_WIDTH / 2, 48);
      this.rings.set(radius, ring);
    }
    return ring;
  }
}

/** A place to mark: a pin standing on it, and the line of a cut ending at it where there is one. */
export interface MarkerSpec {
  at: [number, number, number];
  seam?: [[number, number, number], [number, number, number]];
}

/**
 * The 3D marks the Show toggles add: a pin from above down to the point, and a cut hint's seam as a bar
 * from the silicone's outside in to it. Drawn over everything, as most of them sit inside the mold.
 */
export class DiagnosticMarkers {
  readonly group = new THREE.Group();
  private readonly material = new THREE.MeshBasicMaterial({ color: SELECTED_COLOUR, depthTest: false, transparent: true, opacity: 0.95 });

  set(marks: MarkerSpec[], size: number): void {
    for (const child of [...this.group.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.group.remove(child);
    }
    const add = (part: THREE.Mesh): void => {
      part.renderOrder = 20;
      this.group.add(part);
    };
    for (const { at: [x, y, z], seam } of marks) {
      const head = new THREE.Mesh(new THREE.SphereGeometry(size, 16, 12), this.material);
      head.position.set(x, y, z + size * 3);
      add(head);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.18, size * 0.18, size * 3, 8), this.material);
      stem.rotation.x = Math.PI / 2;
      stem.position.set(x, y, z + size * 1.5);
      add(stem);
      if (seam) {
        const from = new THREE.Vector3(...seam[0]), to = new THREE.Vector3(...seam[1]);
        const length = from.distanceTo(to);
        if (length > 1e-3) {
          const bar = new THREE.Mesh(new THREE.CylinderGeometry(size * 0.3, size * 0.3, length, 8), this.material);
          bar.position.copy(from).add(to).multiplyScalar(0.5);
          // A cylinder stands along y; turn it onto the cut.
          bar.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
          add(bar);
        }
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
