import { effect } from '@preact/signals';
import { allDiagnostics, diagnosticMarkers, markerRadius } from '../app/derived';
import type { Marker } from '../app/pipeline';
import type { Store } from '../app/store';
import { toMat4 } from '../core/base/orient';
import { coverBottom } from '../core/parts/cover';
import { HOVER_COLOUR, SELECTED_COLOUR } from '../view/materials';
import type { OpeningMarker } from '../view/overlays';
import { coplanarTriangles } from '../view/picking';
import { DARK_BACKGROUND, LIGHT_BACKGROUND, type Highlight, type PreviewScene } from '../view/scene';
import { diagnosticKey } from './DiagnosticsCard';
import { hintKey } from './Sidebar/DemoldSection';

function isMember(members: Uint32Array, triangle: number): boolean {
  let low = 0, high = members.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (members[middle] === triangle) return true;
    if (members[middle] < triangle) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

/**
 * Keeps the 3D view in step with the store. What the pipeline sent is handed over only when it is a new
 * object, so a change that moved nothing on screen uploads nothing. T1 draws the field and box proxies
 * from the rim at once; T2's solids take the proxies' place once they are built on that same rim.
 */
export function bindScene(scene: PreviewScene, store: Store): () => void {
  const last: Record<string, unknown> = {};
  const changed = (name: string, value: unknown): boolean => {
    if (last[name] === value) return false;
    last[name] = value;
    return true;
  };

  const geometry = effect(() => {
    void store.tick.value;
    const p = store.pipeline;
    const mesh = p.modelMesh();
    const display = p.displayProxy ?? mesh;
    // Both are recorded every time, so neither change is seen again on the next tick.
    const meshChanged = changed('mesh', mesh), displayChanged = changed('display', display);
    if (meshChanged || displayChanged) scene.setModel(mesh, display);
    const transform = p.oriented?.value.oriented.transform ?? null;
    if (changed('transform', transform)) scene.setModelTransform(transform ? toMat4(transform) : null);

    const field = p.field?.value ?? null;
    if (changed('field', field?.field ?? null)) scene.setField(field?.field ?? null);
    const rim = field?.rim ?? null;

    // A solid stands for the rim it was cut on. Until one exists for the rim on screen, a box does.
    const cover = p.cover && p.field && p.cover.mold === p.field.mold ? p.cover.value : null;
    const base = p.base && p.field && p.base.mold === p.field.mold ? p.base.value : null;
    if (changed('cover', cover)) scene.setPart('cover', cover);
    if (changed('base', base)) scene.setPart('base', base);
    const coverProxy = !cover && rim ? { min: [rim.O.x0, rim.O.y0, coverBottom(rim)] as [number, number, number], max: [rim.O.x1, rim.O.y1, rim.Zt] as [number, number, number] } : null;
    const baseProxy = !base && rim ? { min: [rim.B.x0, rim.B.y0, -rim.Tb] as [number, number, number], max: [rim.B.x1, rim.B.y1, 0] as [number, number, number] } : null;
    if (changed('coverProxy', JSON.stringify(coverProxy))) scene.setProxy('cover', coverProxy);
    if (changed('baseProxy', JSON.stringify(baseProxy))) scene.setProxy('base', baseProxy);

    const placement = p.placement?.value ?? null;
    const funnel = p.funnel?.value ?? null;
    const pours = rim && placement ? placement.copies.filter((c) => c.kind === 'pour').map((c): [number, number, number] => [c.x, c.y, rim.Zt]) : [];
    const funnelChanged = changed('funnel', funnel), poursChanged = changed('pours', JSON.stringify(pours));
    if (funnelChanged || poursChanged) scene.setFunnel(funnel, pours);

    // Each opening has one copy per tile, listed opening by opening.
    const markers: OpeningMarker[] = [];
    if (rim && placement) {
      const tiles = placement.space.offsets.length;
      placement.copies.forEach((copy, k) => {
        const opening = placement.placement.openings[Math.floor(k / tiles)];
        markers.push({ x: copy.x, y: copy.y, kind: copy.kind, valid: opening?.valid ?? true, radius: markerRadius(p, copy.kind) });
      });
    }
    const markersChanged = changed('markers', JSON.stringify(markers)), topChanged = changed('top', rim?.Zt);
    if (markersChanged || topChanged) scene.setOpenings(markers, rim?.Zt ?? 0);

    // Each new file is framed once, when its box is first known.
    const file = p.parsed?.key ?? null;
    if (rim && file && last.framed !== file) {
      last.framed = file;
      scene.frameBox([rim.O.x0, rim.O.y0, -rim.Tb], [rim.O.x1, rim.O.y1, rim.Zt]);
    }
  });

  const highlights = effect(() => {
    void store.tick.value;
    const p = store.pipeline;
    const oriented = p.oriented?.value;
    const mesh = p.modelMesh();
    const hover = store.hoverCandidate.value, picking = store.pickMode.value, triangle = store.hoverTriangle.value;
    const sets: Highlight[] = [];
    if (oriented && mesh && (picking || hover !== null)) {
      sets.push({ triangles: oriented.chosen.members, colour: SELECTED_COLOUR });
      if (hover !== null && oriented.candidates[hover]) sets.push({ triangles: oriented.candidates[hover].members, colour: HOVER_COLOUR });
      if (picking && triangle !== null) {
        // As candidateFromPick has it: a click inside a ranked plane means that whole plane.
        const known = oriented.candidates.find((c) => isMember(c.members, triangle));
        sets.push({ triangles: known ? known.members : coplanarTriangles(mesh, triangle, oriented.planeTol), colour: HOVER_COLOUR });
      }
    }
    const key = sets.map((s) => `${s.colour}:${s.triangles.length}:${s.triangles[0]}`).join('|');
    // A new model clears the highlights with it, so they are drawn again whatever the key says.
    const meshChanged = changed('highlightMesh', mesh), setsChanged = changed('highlights', key);
    if (meshChanged || setsChanged) scene.setHighlights(sets);
  });

  const markers = effect(() => {
    void store.tick.value;
    const p = store.pipeline;
    const rim = p.field?.value.rim;
    const shown = store.shown.value;
    const marks: Marker[] = rim ? allDiagnostics(p).filter((d) => shown.includes(diagnosticKey(d))).flatMap((d) => diagnosticMarkers(d, rim.Zt)) : [];
    // The Demold report's own Show toggles, one per cut hint.
    for (const hint of p.reports?.value.demold.hints ?? []) if (shown.includes(hintKey(hint.id))) marks.push({ at: hint.at, seam: hint.seam });
    const size = rim ? Math.max(1.2, Math.hypot(rim.O.x1 - rim.O.x0, rim.O.y1 - rim.O.y0) * 0.012) : 1;
    if (changed('diagnosticMarkers', JSON.stringify(marks))) scene.setDiagnosticMarkers(marks, size);
  });

  const look = effect(() => {
    const layers = store.layers.value;
    for (const [name, style] of Object.entries(layers)) scene.setLayer(name as keyof typeof layers, style);
    scene.setWireframe(store.wireframe.value);
    scene.setPerspective(store.perspective.value);
    scene.setBackground(store.theme.value === 'light' ? LIGHT_BACKGROUND : DARK_BACKGROUND);
  });

  return () => {
    geometry();
    highlights();
    markers();
    look();
  };
}
