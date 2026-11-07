import { useRef } from 'preact/hooks';
import type { Store } from '../app/store';

/** Reads a dropped or chosen file into the pipeline. A file that is no STL gets the parser's inline error. */
export async function openStl(store: Store, file: File): Promise<void> {
  store.load(new Uint8Array(await file.arrayBuffer()), file.name);
}

/** A button that opens the file chooser, with the input it needs out of the way. */
export function FileButton({ store, label, primary = false }: { store: Store; label: string; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" class={`btn${primary ? ' primary' : ''}`} onClick={() => input.current!.click()}>
        {label}
      </button>
      <input
        ref={input}
        type="file"
        accept=".stl,model/stl,application/sla"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) void openStl(store, file);
        }}
      />
    </>
  );
}
