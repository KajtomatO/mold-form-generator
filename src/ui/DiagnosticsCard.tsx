import { allDiagnostics, diagnosticPoint } from '../app/derived';
import { useStore } from './context';
import { units } from './format';

export function diagnosticKey(d: { code: string; message: string }): string {
  return `${d.code}|${d.message}`;
}

/**
 * Floating: bottom left while all is well, top right once there is a warning or an error. One sentence
 * a row, and a Show toggle on each that names a place, which puts a marker there in the view.
 */
export function DiagnosticsCard() {
  const store = useStore();
  const { pipeline } = store;
  if (!pipeline.modelName) return null;
  const list = allDiagnostics(pipeline);
  const warn = list.some((d) => d.severity !== 'info');
  const top = pipeline.field?.value.rim.Zt ?? 0;
  const shown = store.shown.value;
  return (
    <div class={`card diagnostics ${warn ? 'warn' : 'ok'}`} data-testid="diagnostics" role="status" aria-live="polite">
      <h2>Diagnostics</h2>
      {list.length === 0 ? (
        <div class="all-ok">
          <i />
          No problems found.
        </div>
      ) : (
        <ul>
          {list.map((d) => {
            const key = diagnosticKey(d);
            const located = diagnosticPoint(d, top) !== null;
            return (
              <li class={`diagnostic ${d.severity}`} key={key} data-code={d.code}>
                <span class="sev" aria-label={d.severity} />
                <span>
                  {units(d.message)}
                  {d.byExport ? <span class="where">Found by the last export</span> : d.exportCell ? <span class="where">Checked at full export detail</span> : null}
                </span>
                {located ? (
                  <button type="button" class="btn small" aria-pressed={shown.includes(key)} onClick={() => store.toggleShown(key)}>
                    Show
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
