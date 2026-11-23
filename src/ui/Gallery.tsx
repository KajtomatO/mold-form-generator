import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { creditOf, creditText, entryFacts, GALLERY_LICENCES, sourceName, type GalleryCredit, type GalleryEntry } from '../gallery/catalogue';
import { galleryUrl } from '../gallery/open';
import { useStore } from './context';

/** GA: a card's thumbnail, fetched relative to the page as the models are. */
function Thumbnail({ entry }: { entry: GalleryEntry }) {
  return <img class="gallery-thumb" src={galleryUrl(entry.thumbnail, 'gallery/thumbs/')} alt="" width={96} height={96} loading="lazy" decoding="async" />;
}

/** What a card's button is named, as a screen reader and the tests find it. */
export const openLabel = (entry: GalleryEntry): string => `Open the example ${entry.title}`;

/**
 * GA: the credit of a model not ours (R48): "<Title> by <author> · <source> · <licence>", the author linked to their
 * page, the source to the model's page and the licence to its deed. Plain links, opened in a new tab, never fetched
 * or embedded.
 */
export function CreditLine({ credit, testId }: { credit: GalleryCredit; testId?: string }) {
  const licence = GALLERY_LICENCES[credit.licence];
  return (
    <span class="gallery-credit" data-testid={testId}>
      {credit.title} by{' '}
      <a href={credit.authorUrl} target="_blank" rel="noopener" data-link="author">
        {credit.author}
      </a>
      {' · '}
      <a href={credit.url} target="_blank" rel="noopener" data-link="model">
        {sourceName(credit.url)}
      </a>
      {' · '}
      <a href={licence.deed} target="_blank" rel="noopener" data-link="licence" title={licence.name}>
        {licence.short}
      </a>
    </span>
  );
}

/**
 * GA: the gallery's cards, each a button that opens its model: the thumbnail, the title, its size and count, a
 * "Two-part" badge on a model that suits the two-part cover, and the credit under the button for a model not ours.
 * `onOpened` runs once a card is chosen, as the Examples panel closes then.
 */
export function GalleryCards({ onOpened }: { onOpened?: () => void }) {
  const store = useStore();
  return (
    <ul class="gallery-cards" role="list" aria-label="Examples" data-testid="gallery-cards">
      {store.gallery.value.map((entry) => {
        const credit = creditOf(entry);
        return (
          <li key={entry.id} class="gallery-item" data-gallery={entry.id}>
            <button
              type="button"
              class="gallery-card"
              aria-label={openLabel(entry)}
              title={openLabel(entry)}
              onClick={() => {
                onOpened?.();
                void store.openGallery(entry.id);
              }}
            >
              <Thumbnail entry={entry} />
              <span class="gallery-title">
                {entry.title}
                {entry.twoPart ? (
                  <span class="gallery-badge" title="Suits the two-part cover">
                    Two-part
                  </span>
                ) : null}
              </span>
              <span class="gallery-facts">{entryFacts(entry)}</span>
            </button>
            {credit ? <CreditLine credit={credit} testId="card-credit" /> : null}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * GA: the Model section's Examples panel, inline under the file row and never a dialog. It takes focus on its
 * first card as it opens; Esc, or a card chosen, closes it and gives focus back to the Examples button.
 */
export function ExamplesPanel({ back }: { back: () => HTMLElement | null }) {
  const store = useStore();
  const panel = useRef<HTMLDivElement>(null);
  const close = (): void => {
    store.examplesOpen.value = false;
    back()?.focus();
  };
  // As it is laid out, before a key pressed at once can reach the page.
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('.gallery-card')?.focus();
    // Esc closes it while the focus is in it or on its button, as after a click on the button. Caught on the way
    // down and stopped there, so the same Esc does not also leave Pick a face.
    const keys = (event: KeyboardEvent): void => {
      const at = document.activeElement;
      if (event.key !== 'Escape' || !(panel.current?.contains(at) || at === back())) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    window.addEventListener('keydown', keys, true);
    return () => window.removeEventListener('keydown', keys, true);
  }, []);
  return (
    <div ref={panel} id="examples-panel" class="examples-panel" data-testid="examples-panel">
      <p class="lead">Example models to try the app on. Each replaces the model on screen.</p>
      <GalleryCards onOpened={close} />
    </div>
  );
}

/** The Model section's Examples button, which focus goes to once a model chosen in the empty view is on screen. */
export const EXAMPLES_BUTTON_ID = 'examples-button';

/**
 * GA: the empty view's "Or try an example", its models' thumbnails as buttons, a model not ours with its credit in
 * its title. The one chosen spins while it is fetched; once its model is on screen this goes, and the focus goes to
 * the Examples button, as the panel gives it back there.
 */
export function DropHintExamples() {
  const store = useStore();
  const [pending, setPending] = useState<string | null>(null);
  const open = async (id: string): Promise<void> => {
    setPending(id);
    await store.openGallery(id);
    if (store.pipeline.modelName === null) setPending(null);
    else document.getElementById(EXAMPLES_BUTTON_ID)?.focus();
  };
  return (
    <div class="drop-examples" data-testid="drop-examples">
      <p>Or try an example</p>
      <ul class="drop-example-list" role="list" aria-label="Try an example">
        {store.gallery.value.map((entry) => {
          const credit = creditOf(entry);
          return (
            <li key={entry.id} data-gallery={entry.id}>
              <button
                type="button"
                class="drop-example"
                aria-label={openLabel(entry)}
                aria-busy={pending === entry.id}
                title={`${openLabel(entry)}: ${entryFacts(entry)}${credit ? `. ${creditText(credit)}` : ''}`}
                onClick={() => void open(entry.id)}
              >
                <Thumbnail entry={entry} />
                <span>{entry.title}</span>
                {credit ? <span class="drop-example-by">by {credit.author}</span> : null}
                {pending === entry.id ? <span class="spinner" aria-hidden="true" /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
