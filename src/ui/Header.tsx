import { useStore } from './context';
import { Logo, Moon, Redo, Sun, Undo } from './icons';

export function Header() {
  const store = useStore();
  void store.historyTick.value;
  const light = store.theme.value === 'light';
  const undo = store.history.undoLabel, redo = store.history.redoLabel;
  // Each button's title names the step it takes back or puts back.
  const undoTitle = undo ? `Undo ${undo} (Ctrl+Z)` : 'Nothing to undo';
  const redoTitle = redo ? `Redo ${redo} (Ctrl+Shift+Z or Ctrl+Y)` : 'Nothing to redo';
  return (
    <header class="header">
      <div class="brand">
        <Logo />
        <span>Casting Form Generator</span>
      </div>
      <div class="spacer" />
      <div class="history" role="group" aria-label="History">
        <button type="button" class="icon-btn" data-testid="undo" aria-label={undoTitle} title={undoTitle} disabled={!undo} onClick={() => store.undo()}>
          <Undo />
        </button>
        <button type="button" class="icon-btn" data-testid="redo" aria-label={redoTitle} title={redoTitle} disabled={!redo} onClick={() => store.redo()}>
          <Redo />
        </button>
      </div>
      <button
        type="button"
        class="icon-btn"
        data-testid="theme"
        aria-label={light ? 'Use the dark theme' : 'Use the light theme'}
        title={light ? 'Use the dark theme' : 'Use the light theme'}
        onClick={() => store.setTheme(light ? 'dark' : 'light')}
      >
        {light ? <Moon /> : <Sun />}
      </button>
    </header>
  );
}
