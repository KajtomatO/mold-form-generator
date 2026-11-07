/** How long a saved file's object URL lives. A browser that asks where to save keeps reading it until then. */
export const REVOKE_MS = 10_000;

/**
 * Saves bytes through a Blob and a temporary anchor. The native save-file dialog API needs
 * a secure context, which plain http on a LAN address is not.
 */
export function saveBytes(filename: string, bytes: Uint8Array, mime = 'application/octet-stream'): void {
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
}

/**
 * A saved file's name from the model's: 3dbenchy.stl and "-mold.zip" give 3dbenchy-mold.zip. Characters
 * Windows refuses in a file name become an underscore, as the user's browser runs there.
 */
export function downloadName(model: string, suffix: string): string {
  const stem = model.replace(/\.stl$/i, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'mold';
  return `${stem}${suffix}`;
}
