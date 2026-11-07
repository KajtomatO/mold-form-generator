export type Severity = 'info' | 'warning' | 'error';

/** One row of the Diagnostics card. Numbers behind a message live in the report that raised it. */
export interface Diagnostic {
  code: string;
  severity: Severity;
  /** One sentence, shown to the user as written. */
  message: string;
}
