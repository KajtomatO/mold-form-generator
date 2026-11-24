import { useLayoutEffect, useRef } from 'preact/hooks';
import { HelpAnimation } from './HelpAnimation';
import type { HelpTopic } from './topics';

/**
 * HB: the hint card (docs/PLAN.md, HB): a topic's animation and its one line, beside the control it describes, which
 * names it by `aria-describedby` while it shows, so a screen reader reads the line; the animation is hidden from it.
 * It shows after HINT_DELAY_MS (src/help/config.ts) of hover or keyboard focus, and goes on leave, blur or Esc
 * (useHint in src/ui/mold/MoldTypeSwitch.tsx). It takes no focus and no pointer, and lies in the top layer
 * (`popover="manual"`), so no panel's overflow clips it.
 */

/** The gap between the card and its control, in CSS pixels. */
const GAP = 8;

/**
 * `anchor` is the control it describes, whose top it is level with; `beside`, the block it stands clear of, such as the
 * whole row of tiles, so the card never covers the control's neighbours. `note`, a line more under the summary, such as
 * what the Two-part cover saves on this model. Placed once: the animation holds its place before its sheet is in, so
 * the card's size does not change after.
 */
export function HelpHint({ id, topic, note = null, anchor, beside = anchor }: { id: string; topic: HelpTopic; note?: string | null; anchor: HTMLElement | null; beside?: HTMLElement | null }) {
  const card = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = card.current;
    if (!element || !anchor) return;
    element.showPopover();
    // Beside the block, on the side with more room (the view's, as the sidebar is on the right), its top level with the control's.
    const rect = (beside ?? anchor).getBoundingClientRect(), width = element.offsetWidth, height = element.offsetHeight;
    const level = anchor.getBoundingClientRect().top;
    const left = rect.left - GAP - width >= GAP || rect.left > innerWidth - rect.right ? Math.max(GAP, rect.left - GAP - width) : Math.min(innerWidth - GAP - width, rect.right + GAP);
    const top = Math.min(Math.max(GAP, level), innerHeight - GAP - height);
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    return () => {
      if (element.matches(':popover-open')) element.hidePopover();
    };
  }, [anchor, beside]);
  const media = topic.media;
  return (
    <div class="help-hint" id={id} role="tooltip" popover="manual" ref={card} data-testid="help-hint">
      {media?.kind === 'animation' ? <HelpAnimation type={media.type} mode="loop" /> : null}
      <p>{topic.summary}</p>
      {note ? <p class="help-note">{note}</p> : null}
    </div>
  );
}
