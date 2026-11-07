/**
 * The export block, always in view at the foot of the sidebar. M6b wires these to T3: the ZIP and the
 * single parts with an inline stage bar and Cancel. Until then they say so rather than do nothing.
 */
export function ExportBox() {
  const later = 'Export arrives with the next milestone (M6b).';
  return (
    <div class="export" data-testid="export">
      <h2>Export</h2>
      <button type="button" class="btn primary" disabled title={later}>
        Export ZIP
      </button>
      <div class="singles">
        {['Cover', 'Base', 'Funnel', 'Fit test'].map((part) => (
          <button key={part} type="button" class="btn" disabled title={later}>
            {part}
          </button>
        ))}
      </div>
    </div>
  );
}
