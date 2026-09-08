import type { InvariantCheck } from "../invariants/invariants.js";

/* WHY THERE IS NOTHING TO CHECK HERE.
 *
 * No runtime invariant: a connected device is a peer door, and the one promise a door makes to itself — that every live socket
 * belongs to an id the enrollment store still holds — is checked once, over all three doors, by the substrate
 * they are instances of (peers/invariant.ts). What is left in this directory is the door's own words, the Devices view's readings (served from memory and refreshed behind the answer, waited on briefly once one is too old to speak for the machine, each carrying its own capturedAt), the command gate's judgement per call, and the setup-time seed, which arms once and burns. */

export const owner = "hosts";

export const checks = (): readonly InvariantCheck[] => [];
