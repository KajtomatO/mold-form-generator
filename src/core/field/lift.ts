/**
 * G13.2 step 6: the most a side field's tool may be lifted, as the far side is flattened to hs - 1 - this.
 * buildToolMesh (src/core/solid/tool.ts) asserts it. It has a file of its own so the one-piece path, which
 * imports tool.ts, does not pull in the side field's code.
 */
export const LIFT_MAX = 0.5;
