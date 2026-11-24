import { useEffect, useRef, useState } from 'preact/hooks';
import { HelpAnimation } from './HelpAnimation';
import { Pictogram } from './Pictogram';
import { helpTopic, type HelpId, type HelpTopic } from './topics';

/**
 * HB: a topic's help in full (docs/PLAN.md, HB): its text, then each topic it leads on to with its animation and
 * Replay, or its pictogram, and theirs below. A native `popover="auto"`, so a click outside or Esc closes it and it lies
 * in the top layer; placed under its "?" from getBoundingClientRect, not by CSS anchors, and placed again when the
 * window is resized while it is open. Its content is drawn only while it is open, so each animation plays from the
 * start when it opens. No dialog role: it takes no focus, and the "?" before it in the page is its disclosure
 * (`popovertarget`, `aria-expanded`), so Tab goes on into it; the switch window stays the app's one dialog (D27).
 */

/** Its width at the most, in CSS pixels: two animations side by side. */
const WIDTH = 560;
const GAP = 8;

function Media({ topic }: { topic: HelpTopic }) {
  const [replay, setReplay] = useState(0);
  const media = topic.media;
  if (media?.kind === 'animation') {
    return (
      <div class="help-media">
        <HelpAnimation type={media.type} mode="once" replay={replay} label={`${topic.title}: the parts coming apart`} />
        <button type="button" class="help-replay" aria-label={`Replay: ${topic.title}`} onClick={() => setReplay((r) => r + 1)}>
          Replay
        </button>
      </div>
    );
  }
  if (media?.kind === 'image') {
    return (
      <div class="help-figure pull">
        <Pictogram id={media.pictogram} />
      </div>
    );
  }
  return null;
}

/** A topic the popover leads on to, with its own below it, smaller, and never one already shown. */
function Section({ id, depth, seen }: { id: HelpId; depth: number; seen: Set<string> }) {
  const topic = helpTopic(id);
  if (!topic) return null;
  const Heading = depth === 1 ? 'h4' : 'h5';
  const below = (topic.related ?? []).filter((r) => !seen.has(r) && helpTopic(r));
  for (const r of below) seen.add(r);
  return (
    <section class={`help-topic depth-${depth}`} data-help={id}>
      {depth > 1 ? <Media topic={topic} /> : null}
      <div class="help-words">
        <Heading>{topic.title}</Heading>
        {depth > 1 ? <p class="help-summary">{topic.summary}</p> : null}
        {depth === 1 ? <Media topic={topic} /> : null}
        {topic.body.map((paragraph, k) => (
          <p key={k}>{paragraph}</p>
        ))}
        {below.map((r) => (
          <Section key={r} id={r} depth={depth + 1} seen={seen} />
        ))}
      </div>
    </section>
  );
}

export function HelpPopover({ id, topic: topicId, anchor, onToggle }: { id: string; topic: HelpId; anchor: () => HTMLElement | null; onToggle: (open: boolean) => void }) {
  const element = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const popover = element.current;
    if (!popover) return;
    const place = (): void => {
      const at = anchor()?.getBoundingClientRect();
      const width = Math.min(WIDTH, innerWidth - 2 * GAP);
      popover.style.width = `${width}px`;
      popover.style.left = `${Math.max(GAP, Math.min(at ? at.left : GAP, innerWidth - GAP - width))}px`;
      popover.style.top = `${at ? at.bottom + GAP / 2 : GAP}px`;
      popover.style.maxHeight = `${innerHeight - (at ? at.bottom + GAP / 2 : GAP) - GAP}px`;
    };
    const before = (event: Event): void => {
      if ((event as ToggleEvent).newState === 'open') place();
    };
    const toggle = (event: Event): void => {
      const now = (event as ToggleEvent).newState === 'open';
      setOpen(now);
      onToggle(now);
      if (now) addEventListener('resize', place);
      else removeEventListener('resize', place);
    };
    popover.addEventListener('beforetoggle', before);
    popover.addEventListener('toggle', toggle);
    return () => {
      popover.removeEventListener('beforetoggle', before);
      popover.removeEventListener('toggle', toggle);
      removeEventListener('resize', place);
    };
  }, []);
  const topic = helpTopic(topicId);
  const seen = new Set<string>([topicId, ...(topic?.related ?? [])]);
  return (
    <div class="help-popover" id={id} popover="auto" ref={element} data-testid="help-popover">
      {open && topic ? (
        <>
          <h3 class="help-title">{topic.title}</h3>
          <p class="help-summary">{topic.summary}</p>
          {topic.body.map((paragraph, k) => (
            <p key={k}>{paragraph}</p>
          ))}
          <div class="help-topics">
            {(topic.related ?? []).map((r) => (
              <Section key={r} id={r} depth={1} seen={seen} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
