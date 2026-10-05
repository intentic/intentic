import type { InvariantCheck } from "../invariants/invariants.js";

/* No runtime invariant: the desktop keeps no record. Its display is the browser stack's (browser/cast/display.ts), and the one thing it holds itself, whether the owner is driving, lives in memory and lapses on its own after the owner's last input, so nothing here can come to disagree with anything else across a restart or a poll. */

export const owner = "desktop";

export const checks = (): readonly InvariantCheck[] => [];
