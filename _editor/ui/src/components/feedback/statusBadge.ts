// The badge's vocabulary, in a plain file so DOM-free callers can name a variant without pulling in the SFC. It is the
// kit's one tone vocabulary (tone.ts), under the name the badge has always had.
import type { Tone } from "../../lib/tone.js";

export type StatusVariant = Tone;
