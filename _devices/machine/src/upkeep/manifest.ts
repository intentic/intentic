import type { UpkeepEntry } from "./entry.js";
import { LOGIN_ENTRIES } from "./login.js";
import { RETENTION_ENTRIES } from "./retention.js";
import { RETIRED_ENTRIES } from "./retired.js";
import { SECOND_IC_ENTRIES } from "./second-ic.js";

/* THE KNOWN-ARTIFACTS MANIFEST (2026-10-05): every kind of thing an install of this agent may hold that a release has
   since retired, bounded or reshaped, each with how to find it and what is done with it (entry.ts). It grows with every
   release, and an entry is never taken out while a machine may still hold what it finds: a machine that skipped ten
   releases runs every entry of the one it lands on. This replaced the single `legacy-autostart-retired` marker, which
   retired five login entries once and then stood in for every later cleanup too.

   In order: what old generations left, then what this agent writes itself, then the stores it bounds, then what it can
   only report. */
export const MANIFEST: readonly UpkeepEntry[] = [...RETIRED_ENTRIES, ...LOGIN_ENTRIES, ...RETENTION_ENTRIES, ...SECOND_IC_ENTRIES];
