export type Severity = 'info' | 'warning' | 'error';

/** One row of the Diagnostics card. Numbers behind a message live in the report that raised it. */
export interface Diagnostic {
  code: string;
  severity: Severity;
  /** One sentence, shown to the user as written. */
  message: string;
  /** Where it is in mold coordinates, on the first tile, for the Show toggle's marker. Most name no place. */
  at?: [number, number, number];
  /** Parameter paths of other controls it shows under, besides the one its code belongs to. */
  also?: string[];
}
