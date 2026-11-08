import { useEffect, useRef, useState } from 'preact/hooks';
import { moldExtent } from '../app/derived';
import { AXIS_INDEX, sectionPlane, type Store } from '../app/store';
import type { DropResult } from '../core/analysis/validate';
import type { PreviewScene } from '../view/scene';
import { useStore } from './context';
import { DiagnosticsCard } from './DiagnosticsCard';
import { FileButton, openStl } from './files';
import { fixed, units } from './format';
import { Cross, Inbox } from './icons';
import { PartsList } from './PartsList';
import { bindScene } from './viewSync';

/** Below this many pixels between press and release, a press is a click and not an orbit. */
const CLICK_SLOP = 5;
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software/i;

/** What a press on a ring or on the section's handle started, until the release. */
type PointerDrag =
  | {
      kind: 'opening';
      id: string;
      /** From the ring's centre to where it was grabbed, so the ring does not jump to the pointer. */
      grab: { x: number; y: number };
      /** The grabbed copy's tile offset: the drag moves the first tile's opening, and every copy with it. */
      tile: [number, number];
      from: { x: number; y: number };
      started: boolean;
    }
  /** The plane's place less the handle's line under the pointer at the press, so the plane does not jump. */
  | { kind: 'section'; offset: number };

/**
 * A ring grabbed under the pointer: which opening, and where on it. A press inside the ring of a copy on
 * another tile grabs the same opening, as all copies move together.
 */
function grabRing(scene: PreviewScene, store: Store, clientX: number, clientY: number): PointerDrag | null {
  const placement = store.pipeline.placement?.value;
  const k = scene.markerAt(clientX, clientY);
  const at = scene.topPointAt(clientX, clientY);
  if (!placement || k === null || !at) return null;
  const { offsets } = placement.space;
  const opening = placement.placement.openings[Math.floor(k / offsets.length)];
  if (!opening) return null;
  const tile = offsets[k % offsets.length];
  return { kind: 'opening', id: opening.id, grab: { x: at.x - (opening.x + tile[0]), y: at.y - (opening.y + tile[1]) }, tile, from: { x: clientX, y: clientY }, started: false };
}

/**
 * The 3D view, which is also the drop target for an STL, with its floating cards: parts, diagnostics,
 * the out-of-date badge and a warning when the browser draws in software.
 */
export function Viewport({ scene, canvas }: { scene: PreviewScene | null; canvas: HTMLCanvasElement | null }) {
  const store = useStore();
  const host = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const [softwareSeen, setSoftwareSeen] = useState(false);
  const press = useRef<{ x: number; y: number } | null>(null);
  const hoverFrame = useRef(0);
  const pointerDrag = useRef<PointerDrag | null>(null);
  /** Pointer moves of a drag, applied once a frame: each one asks the pipeline for a cut. */
  const moveFrame = useRef(0);
  const pendingMove = useRef<{ x: number; y: number } | null>(null);
  /** Whether the pointer is over a ring or the handle when nothing is pressed, and whether one is held, for the cursor. */
  const [over, setOver] = useState(false);
  const [grabbing, setGrabbing] = useState(false);
  /** What the last drop in the view had to do, said here for a while, as its row in the sidebar may be out of sight. */
  const [dropNote, setDropNote] = useState<{ text: string; error: boolean } | null>(null);
  const dropNoteTimer = useRef(0);

  // Applies the latest pointer position of a drag: the opening's spot on the first tile, or the plane's place.
  const applyMove = (): void => {
    cancelAnimationFrame(moveFrame.current);
    const move = pendingMove.current, current = pointerDrag.current;
    pendingMove.current = null;
    if (!scene || !move || !current || !host.current) return;
    if (current.kind === 'section') {
      const at = scene.axisValueAt(move.x, move.y, AXIS_INDEX[store.section.value.axis]);
      if (at !== null) store.setSection({ at: at + current.offset });
      return;
    }
    const top = scene.topPointAt(move.x, move.y);
    if (!top) return;
    const rect = host.current.getBoundingClientRect();
    store.dragOpening(current.id, top.x - current.grab.x - current.tile[0], top.y - current.grab.y - current.tile[1], { x: move.x - rect.left, y: move.y - rect.top });
  };

  // Ends a drag of either kind. A ring dragged far enough is dropped where it is, or put back on Esc.
  const endDrag = (drop: boolean): void => {
    const current = pointerDrag.current;
    if (!current) return;
    if (drop) applyMove();
    pendingMove.current = null;
    cancelAnimationFrame(moveFrame.current);
    pointerDrag.current = null;
    setGrabbing(false);
    scene?.setControlsEnabled(true);
    scene?.setHandleHot(false);
    if (current.kind === 'opening' && current.started) {
      const label = store.drag.value?.label ?? 'The opening';
      if (drop) store.dropDrag();
      else store.cancelDrag();
      const moved = drop ? store.lastMove.value : null;
      const note = moved?.id === current.id ? dropText(label, moved.result) : null;
      window.clearTimeout(dropNoteTimer.current);
      setDropNote(note);
      if (note) dropNoteTimer.current = window.setTimeout(() => setDropNote(null), DROP_NOTE_MS);
    }
  };

  useEffect(() => {
    // Esc during a drag puts the opening back where it was. Pick mode's own Esc is App's.
    const keys = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && pointerDrag.current) endDrag(false);
    };
    window.addEventListener('keydown', keys);
    return () => {
      window.removeEventListener('keydown', keys);
      window.clearTimeout(dropNoteTimer.current);
    };
  }, [scene]);

  useEffect(() => {
    if (!scene || !canvas || !host.current) return;
    host.current.prepend(canvas);
    const unbind = bindScene(scene, store);
    const resize = new ResizeObserver(() => scene.resize());
    resize.observe(host.current);
    store.renderer.value = scene.rendererName();
    return () => {
      unbind();
      resize.disconnect();
    };
  }, [scene, canvas]);

  const status = store.pipeline.status();
  const picking = store.pickMode.value;
  const dragged = store.drag.value;
  // A file that did not parse leaves nothing to show parts of, nor anything that will come up to date.
  const parsed = store.pipeline.parsed !== null;
  const software = softwareSeen ? null : SOFTWARE.exec(store.renderer.value)?.[0] ?? null;

  return (
    <div
      ref={host}
      class={`viewport${dragging ? ' dragging' : ''}${picking ? ' picking' : ''}${grabbing ? ' grabbing' : over ? ' grab' : ''}`}
      data-testid="viewport"
      onDragEnter={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (event.target === event.currentTarget || !host.current?.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer?.files[0];
        if (file) void openStl(store, file);
      }}
      // A press on a ring or on the section's handle is a drag of it. Taken here, on the way down to the
      // canvas, the press never reaches the orbit controls listening there, so the camera stays put.
      onPointerDownCapture={(event) => {
        if (!scene || picking || event.button !== 0 || event.target !== canvas || !host.current) return;
        const rim = store.pipeline.field?.value.rim;
        const section = store.section.value;
        let grabbed: PointerDrag | null = null;
        if (section.on && rim && scene.handleAt(event.clientX, event.clientY)) {
          const under = scene.axisValueAt(event.clientX, event.clientY, AXIS_INDEX[section.axis]);
          grabbed = { kind: 'section', offset: under === null ? 0 : sectionPlane(section, moldExtent(rim)).at - under };
        } else {
          grabbed = grabRing(scene, store, event.clientX, event.clientY);
        }
        if (!grabbed) return;
        event.stopPropagation();
        pointerDrag.current = grabbed;
        host.current.setPointerCapture(event.pointerId);
        scene.setControlsEnabled(false);
        if (grabbed.kind === 'section') scene.setHandleHot(true);
        setGrabbing(true);
        setOver(false);
      }}
      // Only a press and release on the canvas itself pick: a click on a floating card, such as a part's
      // eye, bubbles up here too, and must not pick whatever lies behind the card.
      onPointerDown={(event) => (press.current = event.target === canvas ? { x: event.clientX, y: event.clientY } : null)}
      onPointerUp={(event) => {
        if (pointerDrag.current) {
          endDrag(true);
          return;
        }
        const start = press.current;
        press.current = null;
        if (!scene || !picking || !start || event.button !== 0 || event.target !== canvas) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
        const triangle = scene.pickAt(event.clientX, event.clientY);
        if (triangle !== null) store.pickFace(triangle);
      }}
      onPointerCancel={() => endDrag(false)}
      onPointerMove={(event) => {
        const current = pointerDrag.current;
        if (current) {
          // A ring moves only once the pointer has, so a click on one pins nothing.
          if (current.kind === 'opening' && !current.started) {
            if (Math.hypot(event.clientX - current.from.x, event.clientY - current.from.y) <= CLICK_SLOP) return;
            current.started = true;
          }
          pendingMove.current = { x: event.clientX, y: event.clientY };
          cancelAnimationFrame(moveFrame.current);
          moveFrame.current = requestAnimationFrame(applyMove);
          return;
        }
        if (scene && !picking && event.target === canvas && event.buttons === 0) {
          const { clientX, clientY } = event;
          cancelAnimationFrame(hoverFrame.current);
          hoverFrame.current = requestAnimationFrame(() => {
            const onHandle = store.section.value.on && scene.handleAt(clientX, clientY);
            // The handle turns yellow under the pointer, so it can be found before it is pressed.
            scene.setHandleHot(onHandle);
            setOver(onHandle || scene.markerAt(clientX, clientY) !== null);
          });
          return;
        }
        if (!scene || !picking) return;
        cancelAnimationFrame(hoverFrame.current);
        if (event.target !== canvas) {
          store.hoverTriangle.value = null;
          return;
        }
        const { clientX, clientY } = event;
        hoverFrame.current = requestAnimationFrame(() => (store.hoverTriangle.value = scene.pickAt(clientX, clientY)));
      }}
      onPointerLeave={() => {
        if (picking) store.hoverTriangle.value = null;
        if (!pointerDrag.current) scene?.setHandleHot(false);
      }}
    >
      {!scene ? <div class="no-gl">This browser cannot draw the 3D view, as it has no WebGL 2. The settings and checks still work.</div> : null}
      {!store.pipeline.modelName ? (
        <div class="drop-hint">
          <div>
            <Inbox />
            <p>Drop an STL here</p>
            <FileButton store={store} label="Open STL…" />
          </div>
        </div>
      ) : null}
      {parsed ? <PartsList /> : null}
      <DiagnosticsCard />
      {dragged ? <DragTip host={host.current} /> : null}
      {dropNote && !dragged ? (
        <div class={`card drop-note${dropNote.error ? ' error' : ''}`} data-testid="drop-note" role="status">
          <span>{dropNote.text}</span>
          <button type="button" class="mini" aria-label="Dismiss" title="Dismiss" onClick={() => setDropNote(null)}>
            <Cross />
          </button>
        </div>
      ) : null}
      {status.stale && store.pipeline.modelName && (parsed || status.error === null) ? (
        <div class="card stale-badge" data-testid="stale" role="status">
          {status.busy ? <span class="spinner" aria-hidden="true" /> : null}
          out of date
        </div>
      ) : null}
      {software ? (
        <div class="card renderer-card" data-testid="software-renderer" role="note">
          <span>
            <strong>Drawing in software</strong>
            The browser renders 3D with {software}, without the graphics card, so the view may feel slow. Turn on hardware acceleration in its settings.
          </span>
          <button type="button" class="mini" aria-label="Dismiss" title="Dismiss" onClick={() => setSoftwareSeen(true)}>
            <Cross />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** How long the view says what a drop had to do. */
const DROP_NOTE_MS = 8000;

/** What a drop in the view did, when there is more to it than pinning the opening where it was let go. */
function dropText(label: string, result: DropResult): { text: string; error: boolean } | null {
  if (!result.valid) return { text: `No valid place was found for ${label}, so it stays where you let it go, marked invalid.`, error: true };
  const soft = result.warnings.map((warning) => units(warning.message)).join(' ');
  if (result.snapped) return { text: `${label} moved to the nearest valid place, ${fixed(result.x, 1)}, ${fixed(result.y, 1)} mm, as the spot you let it go on was not valid.${soft ? ` ${soft}` : ''}`, error: false };
  return soft ? { text: `${label} is pinned. ${soft}`, error: false } : null;
}

/**
 * Beside the pointer while a ring is dragged: where the opening is, whether it may stand there and why
 * not, where a drop would put it instead, which a faint ring marks on every tile, and what the plan's
 * soft rules would say about it there.
 */
function DragTip({ host }: { host: HTMLDivElement | null }) {
  const store = useStore();
  const drag = store.drag.value;
  if (!drag) return null;
  const tiles = store.pipeline.placement?.value.space.offsets.length ?? 1;
  const { valid, reason, lands, warnings } = drag.check;
  // Kept inside the view, which clips anything past its edges: right of the pointer, or left near the edge.
  const width = 280, height = 92 + 44 * warnings.length;
  const room = { w: host?.clientWidth ?? 800, h: host?.clientHeight ?? 600 };
  const left = drag.pointer.x + 18 + width > room.w ? Math.max(4, drag.pointer.x - 18 - width) : drag.pointer.x + 18;
  const top = Math.min(Math.max(4, drag.pointer.y + 18), Math.max(4, room.h - height));
  return (
    <div class={`card drag-tip${valid ? '' : ' invalid'}`} data-testid="drag-tip" role="status" style={{ left: `${left}px`, top: `${top}px`, width: `${width}px` }}>
      <strong>
        {drag.label} at {fixed(drag.x, 1)}, {fixed(drag.y, 1)} mm
      </strong>
      {valid ? (
        <span>{tiles > 1 ? `Moves on all ${tiles} copies. ` : ''}Let go to pin it here.</span>
      ) : lands ? (
        <span data-testid="drag-reason">
          Not valid here: {reason}. Let go and it lands at {fixed(lands.x, 1)}, {fixed(lands.y, 1)} mm, the faint ring, the nearest valid place.
        </span>
      ) : (
        <span data-testid="drag-reason">Not valid here: {reason}. No valid place was found, so let go and it stays here, marked invalid.</span>
      )}
      {warnings.map((warning) => (
        <span key={warning.code} class="tip-warning" data-code={warning.code}>
          {units(warning.message)}
        </span>
      ))}
    </div>
  );
}
