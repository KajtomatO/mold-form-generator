import { useEffect } from 'preact/hooks';
import type { Store } from '../app/store';
import type { PreviewScene } from '../view/scene';
import { StoreContext } from './context';
import { openStl } from './files';
import { Header } from './Header';
import { Sidebar } from './Sidebar/Sidebar';
import { StatusStrip } from './StatusStrip';
import { Viewport } from './Viewport';

export function App({ store, scene, canvas }: { store: Store; scene: PreviewScene | null; canvas: HTMLCanvasElement | null }) {
  useEffect(() => {
    const keys = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && store.pickMode.value) {
        store.pickMode.value = false;
        store.hoverTriangle.value = null;
      }
    };
    // An STL dropped anywhere else, such as on the sidebar, would make the browser open or save it and
    // leave the app. So it loads as on the viewport, which handles its own drops first.
    const dragOver = (event: DragEvent): void => event.preventDefault();
    const drop = (event: DragEvent): void => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      const file = event.dataTransfer?.files[0];
      if (file) void openStl(store, file);
    };
    // Nothing is saved until project files arrive, so leaving the page with a model loaded asks first.
    const leave = (event: BeforeUnloadEvent): void => {
      if (store.pipeline.modelName) event.preventDefault();
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
