import { useRef, useState } from 'preact/hooks';
import { HelpPopover } from './HelpPopover';
import { HELP, type HelpId } from './topics';

/**
 * HB: the "?" that opens a topic's help in full (src/help/HelpPopover.tsx), placed in a heading or beside a control
 * as `<HelpButton id="<topic>" />`. It is the popover's invoker (`popovertarget`), so a second click closes it, with
 * `aria-expanded` and `aria-controls` saying so to a screen reader.
 */
export function HelpButton({ id }: { id: HelpId }) {
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const popover = `help-${id.replace(/[^a-z0-9-]/gi, '-')}`;
  const title = HELP[id].title;
  return (
    <>
      <button
        type="button"
        class="help-button"
        ref={button}
        data-help={id}
        data-testid={`help-button-${id}`}
        popovertarget={popover}
        aria-controls={popover}
        aria-expanded={open}
        aria-label={`Help: ${title}`}
        title={`Help: ${title}`}
      >
        ?
      </button>
      <HelpPopover id={popover} topic={id} anchor={() => button.current} onToggle={setOpen} />
    </>
  );
}
