import { useEffect } from 'preact/hooks';
import type { Store } from '../app/store';
import type { PreviewScene } from '../view/scene';
import { StoreContext } from './context';
import { openFile } from './files';
import { Header } from './Header';
import { Sidebar } from './Sidebar/Sidebar';
import { StatusStrip } from './StatusStrip';
import { Viewport } from './Viewport';

/**
 * Where typing goes: there the browser's own undo of the text applies, not the app's. A number box that
 * commits to the project marks itself `data-undo="app"` while it holds no typing of its own, as after
 * Enter or a wheel step: what it shows is then the project's, and only the app's undo can take that back.
 */
const TEXT_TYPES = new Set(['text', 'search', 'number', 'email', 'url', 'tel', 'password']);
function takesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.dataset.undo === 'app') return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_TYPES.has(target.type);
}

export function App({ store, scene, canvas }: { store: Store; scene: PreviewScene | null; canvas: HTMLCanvasElement | null }) {
  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && store.pickMode.value) {
        store.pickMode.value = false;
        store.hoverTriangle.value = null;
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      // Ctrl+S and Ctrl+O, as in every program, save and open the project, wherever the focus is: the
      // browser's own would save this page's HTML, or open a file outside the app.
      if ((key === 's' || key === 'o') && !event.shiftKey) {
        event.preventDefault();
        if (key === 's') {
          if (store.canSave()) void store.saveProject();
        } else {
          document.querySelector<HTMLInputElement>('[data-section="model"] input[type="file"]')?.click();
        }
        return;
      }
      // Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo; Cmd on a Mac.
      if (takesText(event.target)) return;
      if (key === 'z' && !event.shiftKey) store.undo();
      else if ((key === 'z' && event.shiftKey) || key === 'y') store.redo();
      else return;
      event.preventDefault();
    };
    // An STL dropped anywhere else, such as on the sidebar, would make the browser open or save it and
    // leave the app. So it loads as on the viewport, which handles its own drops first.
    const dragOver = (event: DragEvent): void => event.preventDefault();
    const drop = (event: DragEvent): void => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file) void openFile(store, file);
    };
    // Only work that would be lost asks first: a change since the last save, load or Export ZIP. A model
    // just opened, or one saved since its last change, is on disk as it is, so leaving it asks nothing.
    const leave = (event: BeforeUnloadEvent): void => {
      if (store.unsaved()) event.preventDefault();
    };
    window.addEventListener('keydown', keys);
    window.addEventListener('dragover', dragOver);
    window.addEventListener('drop', drop);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('keydown', keys);
      window.removeEventListener('dragover', dragOver);
      window.removeEventListener('drop', drop);
      window.removeEventListener('beforeunload', leave);
    };
  }, [store]);

  return (
    <StoreContext.Provider value={store}>
      <div class="shell">
        <Header />
        <div class="main">
          <div class="stage">
            <Viewport scene={scene} canvas={canvas} />
            <StatusStrip />
          </div>
          <Sidebar />
        </div>
      </div>
    </StoreContext.Provider>
  );
}
