import { useEffect, useRef } from 'preact/hooks';
import { largeFigures, memoryQuote, repairedName, SIMPLIFY_MAX_ERROR_MM, simplifiedName, simplifyQuote, TARGET_RANGE } from '../../app/largeModel';
import { MAX_ROUNDS } from '../../core/mesh/simplify';
import { REDUCE_ROUNDS } from '../../core/mesh/reduce';
import { REPAIR_CELL_MAX, REPAIR_CELL_MIN, REPAIR_CELL_STEP } from '../../core/mesh/repair';
import { errorText, filledWords, holesText, LEFT_OUT_KINDS, nearWords } from '../../app/simplified';
import type { RepairOffer } from '../../app/pipeline';
import type { LargePrompt, Repairing, Simplifying, Store } from '../../app/store';
import { useStore } from '../context';
import { FileButton, OPEN_LABEL, OPEN_TITLE } from '../files';
import { formatCount, formatNormal, formatNumber, originLabel, units } from '../format';
import { Cross } from '../icons';
import { ParamRow } from '../ParamRow';
import { Section } from './Section';

/**
 * Load, then confirm the base (G2.4): the ranked planes with the top one chosen, a face picked on the
 * model instead, the plane tolerance, and G2.6's offer to stand on the upper level. Save project sits
 * beside Open, as the pair a maker knows from every program's File menu.
 */
export function ModelSection() {
  const store = useStore();
  const { pipeline } = store;
  const parsed = pipeline.parsed?.value;
  const oriented = pipeline.oriented?.value;
  const plane = store.project.value.plane;
  const keys = pipeline.modelName ? pipeline.keys() : null;
  // Only a report for the plane on screen may offer a move, or a second click would move it twice.
  const footprint = keys && pipeline.footprint?.key === keys.S2 && pipeline.oriented?.key === keys.S2 ? pipeline.footprint.value : null;
  // RM: a rebuilt copy's grid facets are no level to stand on in glue mode (Pipeline.upperLevel).
  const upper = footprint ? store.pipeline.upperLevel() : null;
  const offset = oriented?.chosen.offset ?? 0;
  // S2 stands on the named level only if it still finds it; otherwise a warning says so.
  const standing = oriented !== undefined && plane.upper !== false && Math.abs(offset - plane.upper) <= oriented.planeTol;
  const error = store.pipeline.status().error;
  const project = store.projectName.value, notice = store.fileNotice.value, busy = store.fileBusy.value, saving = store.saving.value, replacing = store.replacing.value;
  // MM2: the large-model question, a copy being made, and the copy on screen (R42).
  const large = store.large.value, simplifying = store.simplifying.value, origin = pipeline.modelOrigin();
  // RM: Repair mesh, offered only when the import finds a problem, the repair being made, and the repaired copy (R43).
  const repairing = store.repairing.value, offer = store.repairOffer();
  const saveName = store.projectFileName();
  const canSave = store.canSave();
  const unsaved = store.unsaved();
  const saveTitle = canSave
    ? `Save the STL with its settings, base face, moved openings and removed vents as ${saveName}, to open again later (Ctrl+S). The view (camera, section, explode, parts shown) and the Export box's options are not kept.`
    : pipeline.modelName === null
      ? 'Load a model to save it as a project'
      : error
        ? 'The STL could not be read, so it cannot be saved as a project'
        : 'Reading the model…';
  // A save's line would read as if the work were on disk after a change: it says so once it is not.
  const message = notice?.saved && unsaved ? `Changed since you saved ${notice.saved}.` : notice?.message;

  // What a file dropped on the view led to shows here, which may be scrolled away or folded up: an error,
  // a warning or a question opens the sidebar, and each scrolls into sight, as nothing else on screen changes.
  const attention = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!busy && !notice && !replacing && !large && !simplifying && !repairing) return;
    if (replacing || large || (notice && notice.severity !== 'info')) store.sidebarCollapsed.value = false;
    const frame = requestAnimationFrame(() => {
      const el = attention.current, box = el?.closest<HTMLElement>('[data-testid="sections"]');
      if (!el || !box || el.offsetHeight === 0) return;
      const at = el.getBoundingClientRect(), view = box.getBoundingClientRect();
      // The Model section's head too, so the file the notice is about shows with it.
      if (at.top < view.top) box.scrollTop = 0;
      else if (at.bottom > view.bottom) box.scrollTop += at.bottom - view.bottom + 8;
    });
    return () => cancelAnimationFrame(frame);
  }, [busy, notice, replacing, large, simplifying, repairing]);

  return (
    <Section id="model" title="Model">
      <div class="file-row">
        <FileButton store={store} label={OPEN_LABEL} title={OPEN_TITLE} primary={!pipeline.modelName} />
        <button type="button" class="btn" data-testid="save-project" disabled={!canSave || saving} title={saveTitle} onClick={() => void store.saveProject()}>
          {saving ? 'Saving…' : 'Save project'}
        </button>
      </div>
      <p class="file-name">
        {project ? (
          <span class="project">
            <span data-testid="project-name">{project}</span>
            {unsaved ? (
              <span class="changed" data-testid="project-changed" title="Changed since it was opened or saved: Save project keeps the changes">
                {' '}
                (changed)
              </span>
            ) : null}
          </span>
        ) : null}
        <span class="name" data-testid="file-name">
          {pipeline.modelName ? `${pipeline.modelName}${parsed ? `, ${formatCount(parsed.triangles)} triangles${originLabel(origin)}` : ''}` : 'Or drop an STL or a project on the view.'}
        </span>
      </p>
      {store.canSimplify() && !large ? (
        <div class="simplify-row">
          <button
            type="button"
            class="btn small"
            data-testid="simplify-loaded"
            title={`Make the mold from a copy of ${pipeline.modelName} with fewer triangles, within ${SIMPLIFY_MAX_ERROR_MM} mm of its shape, which needs much less memory. Your settings, base face, moved openings and removed vents stay; the undo history is cleared. model_oriented.stl stays your own file.`}
            onClick={() => store.simplifyLoaded()}
          >
            Simplify…
          </button>
        </div>
      ) : null}
      {origin?.record && !simplifying ? <SimplifiedNote store={store} /> : null}
      {origin?.repair && !repairing ? <RepairedNote store={store} /> : null}
      {offer && !repairing ? <RepairOfferNote store={store} offer={offer} /> : null}
      <div ref={attention}>
        {busy ? (
          <p class="lead file-busy" data-testid="file-busy" role="status">
            <span class="spinner" aria-hidden="true" />
            {busy}
          </p>
        ) : null}
        {simplifying ? <SimplifyBusy store={store} simplifying={simplifying} /> : null}
        {repairing ? <RepairBusy store={store} repairing={repairing} /> : null}
        {large ? <LargeQuestion store={store} prompt={large} /> : null}
        {replacing ? (
          <div class="note warning file-replace" data-testid="replace-prompt" role="alert">
            <p>
              {replacing.model} has changes that are not saved. Opening {replacing.name} replaces it, and its undo history with it.
            </p>
            <div class="file-replace-buttons">
              <button type="button" class="btn small primary" disabled={!canSave || saving} onClick={() => void store.answerReplace('save')}>
                {saving ? 'Saving…' : 'Save, then open'}
              </button>
              <button type="button" class="btn small" onClick={() => void store.answerReplace('discard')}>
                Open without saving
              </button>
              <button type="button" class="btn small" onClick={() => void store.answerReplace('cancel')}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
        {/* What opening or saving a project file found, here and never in a dialog. */}
        {notice ? (
          <div class={`note file-notice ${notice.severity}`} data-testid="file-notice" data-severity={notice.severity} role={notice.severity === 'error' ? 'alert' : 'status'}>
            <div class="file-notice-head">
              <span>{message}</span>
              <button type="button" class="mini" aria-label="Dismiss" title="Dismiss" onClick={() => (store.fileNotice.value = null)}>
                <Cross />
              </button>
            </div>
            {notice.notes.length > 0 ? (
              <ul>
                {notice.notes.map((note, k) => (
                  <li key={k} class={note.severity}>
                    {units(note.message)}
                  </li>
                ))}
              </ul>
            ) : null}
            {notice.details ? (
              <details class="file-notice-details">
                <summary>Details</summary>
                <p data-testid="file-notice-details">{notice.details}</p>
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
      {/* A file that is no STL, or has no face to stand on, says why right here, next to Open. */}
      {!oriented && error ? (
        <p class="note error" data-testid="model-error">
          {units(error)}
        </p>
      ) : null}
      {oriented ? (
        <>
          <h3>Base face</h3>
          <p class="lead">The flat face the model stands on. The best guess is chosen; check it, or pick another.</p>
          <ul class="candidates" role="listbox" aria-label="Base face candidates" onMouseLeave={() => (store.hoverCandidate.value = null)}>
            {oriented.candidates.map((candidate, rank) => {
              const selected = 'rank' in plane && plane.rank === rank;
              return (
                <li key={rank}>
                  <button
                    type="button"
                    class="candidate"
                    role="option"
                    aria-selected={selected}
                    data-rank={rank}
                    title={`Outward normal (${candidate.normal.map((v) => v.toFixed(3)).join(', ')}), ${candidate.members.length} triangles`}
                    onMouseEnter={() => (store.hoverCandidate.value = rank)}
                    onFocus={() => (store.hoverCandidate.value = rank)}
                    onBlur={() => (store.hoverCandidate.value = null)}
                    // The chosen row again is no change: it would drop the pins and removed vents, and an upper level.
                    onClick={() => (selected ? undefined : store.setPlane({ rank, upper: false }))}
                  >
                    <span class="dot" />
                    <span class="rank">{rank + 1}</span>
                    <span>
                      {formatNormal(candidate.normal)}
                      {candidate.source === 'hole' ? ', open hole' : ''}
                      {candidate.offset > 0 ? `, ${formatNumber(candidate.offset, 2)} mm in` : ''}
                    </span>
                    <span class="area">{formatCount(Math.round(candidate.area))} mm²</span>
                  </button>
                </li>
              );
            })}
          </ul>
          <div class="pick-row">
            <button type="button" class="btn" aria-pressed={store.pickMode.value} data-testid="pick-face" onClick={() => (store.pickMode.value = !store.pickMode.value)}>
              Pick a face on the model
            </button>
            {'pick' in plane ? <span class="lead">Using a picked face.</span> : null}
          </div>
          {store.pickMode.value ? <p class="lead">Click the face the model stands on. Esc cancels.</p> : null}
          <ParamRow path="base.planeTol" />
          {upper ? (
            <div class="note warning" data-testid="upper-level">
              {units(footprint!.levels.diagnostics.find((d) => d.code === 'upper-level')?.message ?? '')}
              <div>
                {/* The very level the warning names: the report knows which one silicone can reach. */}
                <button type="button" class="btn small" onClick={() => store.useUpperLevel(upper.offset)}>
                  Use upper level
                </button>
              </div>
            </div>
          ) : null}
          {standing ? (
            <div class="note" data-testid="on-upper-level">
              The model stands on the level {formatNumber(offset, 2)} mm up, and what lies below it is trimmed off.
              <div>
                <button type="button" class="btn small" onClick={() => store.useUpperLevel(false)}>
                  Use the lower level
                </button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

/** MM2: what a copy being made is doing, as its worker says: each round of the lock loop simplifies, then checks. */
function stepWords(simplifying: Simplifying): string {
  const round = `round ${simplifying.round} of at most ${MAX_ROUNDS}`;
  switch (simplifying.step) {
    case 'read':
      return 'reading the file…';
    case 'parse':
      return 'reading the model…';
    case 'simplify':
      return `${round}, simplifying…`;
    case 'measure':
      return `${round}, checking the surface keeps within ${SIMPLIFY_MAX_ERROR_MM} mm…`;
    case 'check':
      return 'checking the copy is still a closed solid…';
    default:
      return 'writing the copy…';
  }
}

/** MM2: the busy line while a copy is made, with Cancel, which leaves the page as it was. */
function SimplifyBusy({ store, simplifying }: { store: Store; simplifying: Simplifying }) {
  return (
    <p class="lead file-busy" data-testid="simplify-busy" role="status">
      <span class="spinner" aria-hidden="true" />
      <span>
        Simplifying {simplifying.name} to {formatCount(simplifying.target)} triangles, which can take a minute or more: {stepWords(simplifying)}
      </span>
      <button type="button" class="btn small" data-testid="simplify-cancel" onClick={() => store.cancelSimplify()}>
        Cancel
      </button>
    </p>
  );
}

/**
 * MM2: the question before a large model loads, or for the model on screen (Simplify…): its size, what a model
 * this large took in our tests, and the copy that keeps its shape within 0.05 mm (R42). Never a dialog.
 */
function LargeQuestion({ store, prompt }: { store: Store; prompt: LargePrompt }) {
  const cell = store.pipeline.params.quality.cellFinal;
  const top = Math.max(1, Math.min(TARGET_RANGE.max, prompt.triangles - 1));
  const loaded = prompt.kind === 'loaded';
  const inProject = prompt.kind === 'moldproj' ? `, the model in ${prompt.name},` : '';
  const kept = prompt.kind === 'stl' ? '' : ` Your settings, base face, moved openings and removed vents stay${loaded ? '; the undo history is cleared' : ''}.`;
  return (
    <div class="note warning file-replace large-prompt" data-testid="large-prompt" role="alert">
      {prompt.refused ? (
        <p class="large-refused" data-testid="large-refused">
          {prompt.refused}
        </p>
      ) : null}
      <p>
        {prompt.model}
        {inProject} has {largeFigures(prompt, prompt.size)}. A model this large took {memoryQuote(prompt.triangles)} of memory in the browser in our tests, and can make the computer slow or close the page.
      </p>
      {prompt.refused ? null : (
        <p>
          Simplified to{' '}
          <input
            type="number"
            class="num target"
            data-testid="simplify-target"
            aria-label="Triangles to simplify to"
            min={top < TARGET_RANGE.min ? 1 : TARGET_RANGE.min}
            max={top}
            step={TARGET_RANGE.step}
            value={prompt.target}
            onChange={(event) => store.setLargeTarget(Number((event.currentTarget as HTMLInputElement).value))}
          />{' '}
          triangles, or more where its shape needs them, its surface stays within {SIMPLIFY_MAX_ERROR_MM} mm of your file's{cell >= 0.1 ? `, finer than the ${cell} mm grid the mold is built on` : ''}. {simplifyQuote()} The mold is then made from the simplified copy; model_oriented.stl, the model you print and glue in, is still your own file.{kept}
        </p>
      )}
      <div class="file-replace-buttons">
        {prompt.refused ? null : (
          <button type="button" class="btn small primary" data-testid="large-simplify" onClick={() => void store.answerLarge('simplify')}>
            Simplify
          </button>
        )}
        {loaded ? null : (
          <button type="button" class="btn small" data-testid="large-load" onClick={() => void store.answerLarge('load')}>
            Load anyway
          </button>
        )}
        <button type="button" class="btn small" data-testid="large-cancel" onClick={() => void store.answerLarge('cancel')}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** MM2: the copy on screen: how far from the file, and the way back to the file, or the copy saved as an STL. */
function SimplifiedNote({ store }: { store: Store }) {
  const origin = store.pipeline.modelOrigin()!;
  const { from } = origin;
  const record = origin.record!;
  const merged = store.project.value.params.base.mode === 'merged';
  const within = record.errorMm > record.maxErrorMm ? `within ${errorText(record.errorMm)} of ${from.name}, as the copy could not keep to ${record.maxErrorMm} mm everywhere` : `within ${errorText(record.errorMm)} of ${from.name}`;
  const short = record.stoppedBy === 'error' && record.triangles > record.target ? ` Not ${formatCount(record.target)}: simplifying further would have moved the surface more than ${record.maxErrorMm} mm.` : '';
  return (
    <div class="note simplified-note" data-testid="simplified-note">
      <p>
        Made from a copy simplified from {formatCount(from.triangles)} to {formatCount(record.triangles)} triangles, {within}.{short} {merged ? 'In merged mode the base carries this copy.' : 'model_oriented.stl is your own file.'}
      </p>
      <div class="file-replace-buttons">
        <button
          type="button"
          class="btn small"
          data-testid="use-original"
          title={`Open ${from.name} again as it is, with all ${formatCount(from.triangles)} triangles, keeping the settings, base face, moved openings and removed vents; the undo history is cleared.`}
          onClick={() => void store.useOriginal()}
        >
          Use the original
        </button>
        <button type="button" class="btn small" data-testid="save-simplified" title={`Save the simplified copy the mold is made from as ${simplifiedName(from.name)}.`} onClick={() => store.saveSimplified()}>
          Save simplified STL
        </button>
      </div>
    </div>
  );
}

const count = (n: number): string => formatCount(n);

/** RM: what is wrong with the file, as the offer's first paragraph says it. */
function offerProblem(name: string, offer: RepairOffer): string {
  if (offer.kind === 'folds') return `${name} folds through itself in ${count(offer.folds)} ${offer.folds === 1 ? 'place' : 'places'}, where its surface turns inside out, so its volume and a merged base may be wrong.`;
  const parts = [
    offer.holes > 0 ? holesText(offer.holes, offer.holeArea) : '',
    offer.nonManifold > 0 ? `${count(offer.nonManifold)} ${offer.nonManifold === 1 ? 'edge' : 'edges'} shared by more than two faces` : '',
    offer.misoriented > 0 ? `${count(offer.misoriented)} ${offer.misoriented === 1 ? 'edge' : 'edges'} between faces turned opposite ways` : '',
  ].filter(Boolean);
  const has = parts.length === 0 ? 'its surface encloses no space' : `it has ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`}`;
  return units(`${name} is not a closed solid: ${has}. So merged mode cannot be used with it, and the silicone thickness cannot be measured.`);
}

/** RM: what Repair mesh will do, as the offer's second paragraph says it. */
function offerAction(offer: RepairOffer, cell: number): string {
  const after = 'The mold is then made from that closed copy; model_oriented.stl stays your own file.';
  if (offer.fill) {
    const holes = offer.kind === 'open' ? offer.holes : 0;
    const turned = offer.kind === 'open' && offer.misoriented > 0;
    const close = holes > 0 ? `closes ${holes === 1 ? 'its hole' : `its ${count(holes)} holes`} with new triangles` : '';
    const turn = turned ? 'turns its faces the right way' : '';
    return `Repair mesh ${[close, turn].filter(Boolean).join(' and ')} and keeps every triangle of your file. ${after}`;
  }
  return `Repair mesh rebuilds it as one closed solid on a grid of ${cell.toFixed(2)} mm, which takes from seconds to a minute: details thinner than the grid, such as fins and narrow gaps, go, and parts closer than it join. ${after}`;
}

/**
 * RM: the offer under the file row, shown only when the import finds a problem (decision B): what is wrong, what
 * Repair mesh will do, the grid of a rebuild (empty for auto), and the button. Never automatic, never a dialog.
 */
function RepairOfferNote({ store, offer }: { store: Store; offer: RepairOffer }) {
  const name = store.pipeline.modelName ?? '';
  const known = store.repairCellFacts();
  const typed = store.repairCell.value;
  const auto = known?.auto ?? REPAIR_CELL_MIN;
  const problem = store.repairCellProblem();
  return (
    <div class="note warning repair-offer" data-testid="repair-offer" data-kind={offer.kind}>
      <p>{offerProblem(name, offer)}</p>
      <p>{offerAction(offer, typed ?? auto)}</p>
      {offer.fill ? null : (
        <label class="repair-cell" title="The grid the surface is rebuilt on: a finer one keeps thinner details but makes more triangles and takes longer. Auto picks the finest this model takes, about 3 million triangles before they are reduced.">
          <span>Grid</span>
          <input
            type="number"
            class="num"
            data-testid="repair-cell"
            aria-label="Grid to rebuild the surface on, in mm"
            min={REPAIR_CELL_MIN}
            max={REPAIR_CELL_MAX}
            step={REPAIR_CELL_STEP}
            placeholder={`auto, ${auto.toFixed(2)}`}
            value={typed === null ? '' : String(typed)}
            onChange={(event) => {
              const text = (event.currentTarget as HTMLInputElement).value.trim();
              store.setRepairCell(text === '' ? null : Number(text));
            }}
          />
          <span>mm</span>
        </label>
      )}
      {problem ? (
        <p class="repair-cell-problem" data-testid="repair-cell-problem">
          {problem}
        </p>
      ) : null}
      <div class="file-replace-buttons">
        <button
          type="button"
          class="btn small primary"
          data-testid="repair-mesh"
          disabled={problem !== null}
          title={`Make a closed copy of ${name} and make the mold from it. Your settings, base face, moved openings and removed vents stay; the undo history is cleared. model_oriented.stl stays your own file.`}
          onClick={() => void store.repairMesh()}
        >
          Repair mesh
        </button>
      </div>
    </div>
  );
}

/** RM: what a repair being made is doing, as its worker says. */
function repairWords(repairing: Repairing): string {
  const grid = (repairing.cell ?? repairing.auto ?? 0).toFixed(2);
  const round = `round ${repairing.round} of at most ${MAX_ROUNDS}`;
  switch (repairing.step) {
    case 'read':
      return 'reading the file…';
    case 'parse':
      return 'reading the model…';
    case 'orient':
      return 'checking its faces…';
    case 'fill':
      return 'closing its holes…';
    case 'rebuild':
      return `rebuilding its surface on a ${grid} mm grid, ${repairing.total > 0 ? Math.round((100 * repairing.done) / repairing.total) : 0}%…`;
    case 'reduce':
      return `reducing the rebuilt surface, round ${Math.max(1, repairing.done)} of at most ${REDUCE_ROUNDS}…`;
    case 'check':
      return 'checking the repaired copy is a closed solid…';
    case 'compare':
      return 'measuring how far your file lies from the repaired copy…';
    case 'simplify':
      return `${round}, simplifying the repaired copy…`;
    case 'measure':
      return `${round}, checking it keeps within ${SIMPLIFY_MAX_ERROR_MM} mm…`;
    default:
      return 'writing the repaired copy…';
  }
}

/** RM: the busy line while a repair is made, with Cancel, which leaves the page as it was. */
function RepairBusy({ store, repairing }: { store: Store; repairing: Repairing }) {
  return (
    <p class="lead file-busy" data-testid="repair-busy" role="status">
      <span class="spinner" aria-hidden="true" />
      <span>
        Repairing {repairing.name}: {repairWords(repairing)}
      </span>
      <button type="button" class="btn small" data-testid="repair-cancel" onClick={() => store.cancelRepair()}>
        Cancel
      </button>
    </p>
  );
}

/** RM: the repaired copy on screen: what the repair did, how far the file lies from it, and the way back, or the copy saved. */
function RepairedNote({ store }: { store: Store }) {
  const origin = store.pipeline.modelOrigin()!;
  const { from } = origin;
  const record = origin.repair!.record;
  const merged = store.project.value.params.base.mode === 'merged';
  let text: string;
  if (record.method === 'filled') {
    const added = (record.simplified ? 0 : record.triangles - from.triangles);
    const closedWith = record.holes > 0 && record.turned === 0 && added > 0 ? ` with ${count(added)} new ${added === 1 ? 'triangle' : 'triangles'}` : '';
    const then = record.simplified ? `, then simplified to ${count(record.simplified.triangles)} triangles within ${errorText(record.simplified.errorMm)}` : '';
    text = `Made from a repaired copy: ${filledWords(record)}${closedWith}, every triangle of ${from.name} kept${then}. ${merged ? 'In merged mode the base carries this copy.' : 'model_oriented.stl is your own file.'}`;
  } else {
    const far = record.outside;
    const left = far ? `, except ${count(far.triangles)} ${far.triangles === 1 ? 'triangle' : 'triangles'} the repair left out, up to ${far.farthestMm.toFixed(2)} mm away, ${LEFT_OUT_KINDS} (Diagnostics shows where)` : '';
    const last = merged ? `In merged mode the base carries this copy${far ? ', without those parts' : ''}.` : `model_oriented.stl is your own file${far ? ', and the mold leaves room for those parts too' : ''}.`;
    text = `Made from a copy of ${from.name} rebuilt as one closed solid on a ${(record.cell ?? 0).toFixed(2)} mm grid${record.cellAsked === null ? ' (auto)' : ''}, ${count(record.triangles)} triangles. Your file lies ${nearWords(record)}${left}. ${last}`;
  }
  return (
    <div class="note repaired-note" data-testid="repaired-note">
      <p>{units(text)}</p>
      <div class="file-replace-buttons">
        <button
          type="button"
          class="btn small"
          data-testid="use-original"
          title={`Open ${from.name} again as it is, keeping the settings, base face, moved openings and removed vents; the undo history is cleared.`}
          onClick={() => void store.useOriginal()}
        >
          Use the original
        </button>
        <button type="button" class="btn small" data-testid="save-repaired" title={`Save the repaired copy the mold is made from as ${repairedName(from.name)}.`} onClick={() => store.saveRepaired()}>
          Save repaired STL
        </button>
      </div>
    </div>
  );
}
