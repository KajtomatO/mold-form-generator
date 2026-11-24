import { signal } from '@preact/signals';
import { useContext, useEffect, useRef, useState } from 'preact/hooks';
import { StoreContext } from '../ui/context';
import { EXPLODE_SCALE, EXPLODE_SIZE, explodeFile, framePosition, type ExplodeManifest, type HelpTheme } from './media';

/**
 * HB: a mold type's explode animation (docs/PLAN.md, HB): its sprite sheet in public/help/, for the theme on screen,
 * stepped frame by frame by requestAnimationFrame. `loop` plays, holds the parts apart for a second and plays again;
 * `once` plays on showing and again on each Replay. It pauses while the page is hidden. With reduced motion it shows
 * its last frame, the parts apart, and plays once only when Replay is clicked. Until explode.json is in, it holds its
 * frame's place, empty, so the card or popover round it never grows once placed.
 */

/** Fetched once, relative to the page, so it loads under any prefix the site is served at; asked again after a failure. */
const manifest = signal<ExplodeManifest | null>(null);
const failed = signal(false);
let asked = false;

export function helpUrl(file: string, base = document.baseURI): string {
  return new URL(`help/${file}`, base).href;
}

function loadManifest(): void {
  if (asked) return;
  asked = true;
  fetch(helpUrl('explode.json'))
    .then((response) => (response.ok ? (response.json() as Promise<ExplodeManifest>) : Promise.reject(new Error(`${response.status}`))))
    .then(
      (value) => {
        manifest.value = value;
        failed.value = false;
      },
      // The help still has its text and pictograms; only the console says why the animations are missing. The next
      // hover or opening asks again, as a deploy's 404 or a dropped connection passes.
      (error: unknown) => {
        console.warn(`The help's animations could not be loaded: ${String(error)}`);
        failed.value = true;
        asked = false;
      },
    );
}

/** Starts the sheet's download before the card shows it, as the hint waits 400 ms first. */
export function preloadAnimation(type: string, theme: HelpTheme): void {
  loadManifest();
  const image = new Image();
  image.src = helpUrl(explodeFile(type, theme));
}

const REDUCE = '(prefers-reduced-motion: reduce)';

/** Whether the system asks for reduced motion, kept up to date as it changes. */
export function useReducedMotion(): boolean {
  const query = typeof matchMedia === 'function' ? matchMedia(REDUCE) : null;
  const [reduced, setReduced] = useState(query?.matches ?? false);
  useEffect(() => {
    if (!query) return;
    const change = (): void => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

/** `label` names the picture for a screen reader; without one it is hidden from it, as where a line beside it says the same. */
export function HelpAnimation({ type, mode, replay = 0, label }: { type: string; mode: 'loop' | 'once'; replay?: number; label?: string }) {
  // The theme alone, not the store's every tick, so a change of the pipeline does not draw the frame again.
  const store = useContext(StoreContext);
  const theme: HelpTheme = (store?.theme.value ?? document.documentElement.dataset.theme) === 'light' ? 'light' : 'dark';
  loadManifest();
  const sheet = manifest.value;
  const reduced = useReducedMotion();
  const frames = sheet?.frames ?? 1;
  const last = frames - 1;
  const [frame, setFrame] = useState(0);
  const shown = useRef(0);
  // Under reduced motion, the Replay clicks already played, so a later run of the effect (a new sheet, the theme, the
  // setting) shows the last frame and plays nothing until the next click.
  const played = useRef(replay);
  // The sheet for the theme on screen, played only once it is decoded, so no frame of it is shown blank. The decoded
  // image is held while it shows, so the browser keeps it for the background.
  const url = helpUrl(explodeFile(type, theme));
  const [loaded, setLoaded] = useState<string | null>(null);
  const held = useRef<HTMLImageElement | null>(null);
  const ready = sheet !== null && loaded === url;
  useEffect(() => {
    let live = true;
    const image = new Image();
    held.current = image;
    image.src = url;
    image.decode().then(
      () => {
        if (live) setLoaded(url);
      },
      () => console.warn(`The help's animation ${url} could not be loaded.`),
    );
    return () => {
      live = false;
    };
  }, [url]);
  useEffect(() => {
    if (!sheet || !ready) return;
    // Reduced motion: the parts apart, still, until a new Replay click asks for one play.
    const play = !reduced || replay > played.current;
    played.current = replay;
    if (!play) {
      shown.current = last;
      setFrame(last);
      return;
    }
    const once = mode === 'once' || reduced;
    // A loop holds the last frame for a second, then starts again.
    const cycle = frames + sheet.fps;
    let raf = 0, previous: number | null = null, elapsed = 0;
    const step = (now: number): void => {
      // A long gap, as after the page was hidden, does not skip the animation on.
      elapsed += previous === null ? 0 : Math.min(now - previous, 100);
      previous = now;
      const tick = Math.floor((elapsed * sheet.fps) / 1000);
      const k = once ? Math.min(tick, last) : Math.min(tick % cycle, last);
      if (k !== shown.current) {
        shown.current = k;
        setFrame(k);
      }
      if (once && k === last) return;
      raf = requestAnimationFrame(step);
    };
    const start = (): void => {
      previous = null;
      raf = requestAnimationFrame(step);
    };
    const visibility = (): void => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !(once && shown.current === last)) start();
    };
    shown.current = 0;
    setFrame(0);
    start();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [sheet, ready, mode, replay, reduced]);
  // Its place held, empty, while explode.json is on its way.
  if (!sheet && !failed.value) {
    const style = { width: `${EXPLODE_SIZE[0] / EXPLODE_SCALE}px`, height: `${EXPLODE_SIZE[1] / EXPLODE_SCALE}px` };
    return <div class="help-anim" aria-hidden="true" data-type={type} data-ready="false" style={style} />;
  }
  if (!sheet || !sheet.types[type]) return null;
  const [columns, rows] = sheet.grid;
  const [x, y] = framePosition(Math.min(frame, last), sheet.grid);
  return (
    <div
      class="help-anim"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
      data-type={type}
      data-frame={Math.min(frame, last)}
      data-ready={ready ? 'true' : 'false'}
      style={{
        width: `${sheet.size[0] / sheet.scale}px`,
        height: `${sheet.size[1] / sheet.scale}px`,
        backgroundImage: ready ? `url("${url}")` : undefined,
        backgroundSize: `${columns * 100}% ${rows * 100}%`,
        backgroundPosition: `${x}% ${y}%`,
      }}
    />
  );
}
