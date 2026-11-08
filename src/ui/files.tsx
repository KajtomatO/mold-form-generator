import { useRef } from 'preact/hooks';
import type { Store } from '../app/store';

/** What the chooser offers: STLs, .moldproj projects, and the export ZIP or project.json whose settings open on the model. */
const ACCEPT = '.stl,model/stl,application/sla,.moldproj,.zip,application/zip,.json,application/json';

export const OPEN_LABEL = 'Open STL or project…';
export const OPEN_TITLE = 'Open an STL, or a project saved as .moldproj (Ctrl+O). The ZIP an export saved, or its project.json, opens its settings on the model loaded.';

/** Reads a dropped or chosen file into the store, which tells an STL from a project file. */
export async function openFile(store: Store, file: File): Promise<void> {
  await store.openFile(file);
}

/** A button that opens the file chooser, with the input it needs out of the way. */
export function FileButton({ store, label, primary = false, title }: { store: Store; label: string; primary?: boolean; title?: string }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class={`btn${primary ? ' primary' : ''}`} data-testid="open-file" title={title} onClick={() => input.current!.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void openFile(store, file);
        }}
      />
    </>
  );
}
