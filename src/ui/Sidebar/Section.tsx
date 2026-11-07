import type { ComponentChildren } from 'preact';

export function Section({ id, title, children }: { id: string; title: string; children: ComponentChildren }) {
  return (
    <section class="section" data-section={id} aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}
