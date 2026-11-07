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
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
