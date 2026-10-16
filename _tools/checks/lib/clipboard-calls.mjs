// What clipboard-tiers.mjs reads a file for, kept callable on bare text so its suite can feed it some.
import { doorRule } from "../doors.rules.mjs";
import { findSites } from "./doors.mjs";

/** Every direct clipboard reach in `text`, as `{ line, why }`, less the ones a `// allow(clipboard-tiers): <reason>` excuses. */
export const clipboardCalls = (text) => findSites(doorRule(`clipboard-tiers`), ``, text).sites;
