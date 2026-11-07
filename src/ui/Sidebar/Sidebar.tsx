import { DIAGNOSTIC_PARAM, allDiagnostics } from '../../app/derived';
import type { ShownDiagnostic } from '../../app/pipeline';
import type { ParamPath } from '../../app/stages';
import { ProblemsContext, useStore } from '../context';
import { ExportBox } from '../ExportBox';
import { Chevron } from '../icons';
import { ModelSection } from './ModelSection';
import { AdvancedSection, BaseSection, CoverSection, GridSection, SiliconeSection } from './ParamSections';
import { PourSection } from './PourSection';

/** The sidebar in workflow order. Only the sections scroll; Export stays at the foot. */
export function Sidebar() {
  const store = useStore();
  const collapsed = store.sidebarCollapsed.value;
  // Every problem that concerns a control shows under it, as well as in the Diagnostics card.
  const problems = new Map<ParamPath, ShownDiagnostic[]>();
  for (const diagnostic of allDiagnostics(store.pipeline)) {
    const path = DIAGNOSTIC_PARAM[diagnostic.code];
    if (path) problems.set(path, [...(problems.get(path) ?? []), diagnostic]);
  }
  return (
    <aside class={`sidebar${collapsed ? ' collapsed' : ''}`} aria-label="Settings">
      <button
        type="button"
        class="collapse-tab"
        aria-label={collapsed ? 'Show settings' : 'Hide settings'}
        title={collapsed ? 'Show settings' : 'Hide settings'}
        aria-expanded={!collapsed}
        onClick={() => (store.sidebarCollapsed.value = !collapsed)}
      >
        <span style={{ transform: collapsed ? 'rotate(180deg)' : undefined, display: 'grid' }}>
          <Chevron />
        </span>
      </button>
      <ProblemsContext.Provider value={problems}>
        <div class="sections" data-testid="sections">
          <ModelSection />
          <BaseSection />
          <SiliconeSection />
          <CoverSection />
          <PourSection />
          <GridSection />
          <AdvancedSection />
        </div>
      </ProblemsContext.Provider>
      <ExportBox />
    </aside>
  );
}
