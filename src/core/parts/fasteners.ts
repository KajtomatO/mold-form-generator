/**
 * The screws and nuts M10's bolt option is built for, by the standards they are bought by. Every value is
 * the standard's largest, so any screw or nut made to it fits what is cut for it.
 *
 * Screws are 90 degree countersunk heads. ISO 10642 (hexagon socket) covers M3 and up and gives dk as the
 * theoretical sharp-edged diameter, so the head's cone is (dk - d) / 2 high. M2.5 is not in ISO 10642 or
 * DIN 7991, so its head comes from ISO 14581 (hexalobular socket), which shares ISO 7046's head. DIN 7991
 * heads (M3: dk 6, k 1.7; M4: dk 8, k 2.3) are smaller, so they sit a little deeper in the same countersink.
 * Nuts are ISO 4032 hex nuts: s across flats, m the height.
 */
export type BoltSize = 'M2.5' | 'M3' | 'M4';

export const BOLT_SIZES = ['M2.5', 'M3', 'M4'] as const satisfies readonly BoltSize[];

export interface Fastener {
  /** Thread diameter d. */
  d: number;
  /** Coarse pitch P. */
  pitch: number;
  /** Countersunk head: theoretical diameter dk at the flat face, with the 90 degree cone under it. */
  headDiameter: number;
  /** Height of that cone, (dk - d) / 2, as the standard tabulates k. */
  headHeight: number;
  /** The screw's standard. */
  screw: string;
  /** Hex nut across flats s. */
  nutFlats: number;
  /** Hex nut height m. */
  nutHeight: number;
}

export const FASTENERS: Readonly<Record<BoltSize, Fastener>> = {
  'M2.5': { d: 2.5, pitch: 0.45, headDiameter: 5.5, headHeight: 1.5, screw: 'ISO 14581', nutFlats: 5, nutHeight: 2 },
  M3: { d: 3, pitch: 0.5, headDiameter: 6.72, headHeight: 1.86, screw: 'ISO 10642', nutFlats: 5.5, nutHeight: 2.4 },
  M4: { d: 4, pitch: 0.7, headDiameter: 8.96, headHeight: 2.48, screw: 'ISO 10642', nutFlats: 7, nutHeight: 3.2 },
};

/** Overall lengths, head included as countersunk screws are measured: the preferred series of ISO 888 in this range. */
export const BOLT_LENGTHS = [6, 8, 10, 12, 16, 20, 25, 30, 35, 40] as const;

/** Four, one in each corner: count is not a setting. */
export const BOLT_COUNT = 4;

/** Thread past the nut, in pitches: one or two full threads is the usual rule, and a screw's end is chamfered by about one. */
export const THREAD_PAST_PITCHES = 2;

/** The blind hole runs this far past the screw's end, in mm: more than ISO 4759's length tolerance up to 40 mm, so a screw never bottoms out before it clamps. */
export const TIP_CLEARANCE = 1;

/**
 * The least plastic left between the countersink and the plate's top, in mm, and in layers where layers
 * are thick: README.txt asks for 4 solid top layers, and under about 1 mm a printed plate lets the head
 * pull through.
 */
export const OVER_SINK_MM = 1;
export const OVER_SINK_LAYERS = 4;

/**
 * The longest bridge a nut slot's ceiling may span in print pose, in mm. Common FDM design guidance keeps
 * unsupported bridges under 10 mm, which prints flat without bridge tuning, and the nut bears on this face.
 */
export const BRIDGE_LIMIT = 10;

/**
 * What one snug bolt is counted on to hold, in N: far under what an M2.5 screw and a printed nut slot
 * carry (hundreds of N), since printed plastic creeps under a steady load. An estimate, like the tape's.
 */
export const BOLT_HOLD_N = 50;

/** The thread the screw must pass the nut by, in mm. */
export function threadPast(fastener: Fastener): number {
  return THREAD_PAST_PITCHES * fastener.pitch;
}

/** The shortest standard length at or over `reach`, or null if even the longest is short. */
export function standardLength(reach: number): number | null {
  return BOLT_LENGTHS.find((length) => length >= reach - 1e-9) ?? null;
}

/** The longest standard length at or under `fits`, or null if even the shortest is too long. */
export function longestLength(fits: number): number | null {
  return [...BOLT_LENGTHS].reverse().find((length) => length <= fits + 1e-9) ?? null;
}
