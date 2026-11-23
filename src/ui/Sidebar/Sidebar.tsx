import { DIAGNOSTIC_PARAM, allDiagnostics } from '../../app/derived';
import type { ShownDiagnostic } from '../../app/pipeline';
import type { ParamPath } from '../../app/stages';
import { ProblemsContext, useStore } from '../context';
import { ExportBox } from '../ExportBox';
import { Chevron } from '../icons';
import { ModelSection } from './ModelSection';
import { DemoldSection } from './DemoldSection';
import { AdvancedSection, BaseSection, CoverSection, GridSection, SiliconeSection } from './ParamSections';
import { PourSection } from './PourSection';
import { MoldTypeIcon } from '../mold/MoldTypeIcon';
import { MoldTypeSwitch } from '../mold/MoldTypeSwitch';
import { SwitchDialog } from '../mold/SwitchDialog';

/** The sidebar in workflow order. Only the sections scroll; the mold type stays at the top (MT), and Export at the foot. */
export function Sidebar() {
  const store = useStore();
  const collapsed = store.sidebarCollapsed.value;
  // Every problem that concerns a control shows under it, as well as in the Diagnostics card.
  const problems = new Map<ParamPath, ShownDiagnostic[]>();
  for (const diagnostic of allDiagnostics(store.pipeline)) {
    const paths = [DIAGNOSTIC_PARAM[diagnostic.code], ...((diagnostic.also ?? []) as ParamPath[])].filter(Boolean);
    for (const path of new Set(paths)) problems.set(path, [...(problems.get(path) ?? []), diagnostic]);
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
      {/* MT: collapsed, the rail shows the type on screen, which opens the sidebar. */}
      {collapsed ? (
        <button
          type="button"
          class="mold-rail"
          data-testid="mold-rail"
          aria-label={`Mold type: ${store.moldTypeName(store.moldType())}. Show settings`}
          title={`Mold type: ${store.moldTypeName(store.moldType())}. Click to show the settings.`}
          onClick={() => (store.sidebarCollapsed.value = false)}
        >
          <MoldTypeIcon icon={store.moldTypeUi.value[store.moldType()]?.icon ?? store.moldType()} />
        </button>
      ) : null}
      <MoldTypeSwitch />
      <ProblemsContext.Provider value={problems}>
        <div class="sections" data-testid="sections">
          <ModelSection />
          <BaseSection />
          <SiliconeSection />
          <CoverSection />
          <PourSection />
          <GridSection />
          <DemoldSection />
          <AdvancedSection />
        </div>
      </ProblemsContext.Provider>
      <ExportBox />
      <SwitchDialog />
    </aside>
  );
}
