// What format-tiers.mjs reads a file for, kept callable on bare text so its suite can feed it some.
import { doorRule } from "../doors.rules.mjs";
import { findSites } from "./doors.mjs";

/** Every hand-made formatting in `text`, as `{ line, why }`, less the ones a `// allow(format-tiers): <reason>` excuses. */
export const formatCalls = (text) => findSites(doorRule(`format-tiers`), ``, text).sites;
