import { useStore } from './context';
import { Logo, Moon, Sun } from './icons';

export function Header() {
  const store = useStore();
  const light = store.theme.value === 'light';
  return (
    <header class="header">
      <div class="brand">
        <Logo />
        <span>Casting Form Generator</span>
      </div>
      <div class="spacer" />
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
