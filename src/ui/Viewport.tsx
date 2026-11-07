import { useEffect, useRef, useState } from 'preact/hooks';
import type { PreviewScene } from '../view/scene';
import { useStore } from './context';
import { DiagnosticsCard } from './DiagnosticsCard';
import { FileButton, openStl } from './files';
import { Cross, Inbox } from './icons';
import { PartsList } from './PartsList';
import { bindScene } from './viewSync';

/** Below this many pixels between press and release, a press is a click and not an orbit. */
const CLICK_SLOP = 5;
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software/i;

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
  // A file that did not parse leaves nothing to show parts of, nor anything that will come up to date.
  const parsed = store.pipeline.parsed !== null;
  const software = softwareSeen ? null : SOFTWARE.exec(store.renderer.value)?.[0] ?? null;

  return (
    <div
      ref={host}
      class={`viewport${dragging ? ' dragging' : ''}${picking ? ' picking' : ''}`}
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
      // Only a press and release on the canvas itself pick: a click on a floating card, such as a part's
      // eye, bubbles up here too, and must not pick whatever lies behind the card.
      onPointerDown={(event) => (press.current = event.target === canvas ? { x: event.clientX, y: event.clientY } : null)}
      onPointerUp={(event) => {
        const start = press.current;
        press.current = null;
        if (!scene || !picking || !start || event.button !== 0 || event.target !== canvas) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > CLICK_SLOP) return;
        const triangle = scene.pickAt(event.clientX, event.clientY);
        if (triangle !== null) store.pickFace(triangle);
      }}
      onPointerMove={(event) => {
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
