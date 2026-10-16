// What process-tiers.mjs reads a file for, kept callable on bare text so its suite can feed it some.
import { doorRule } from "../doors.rules.mjs";
import { findSites } from "./doors.mjs";

/**
 * Every hand-started process in one file's text, `{ line, what }`, minus the ones excused at their site with
 * `// allow(process-tiers): <reason>`.
 */
export const processCalls = (text) => findSites(doorRule(`process-tiers`), ``, text).sites.map(({ line, why }) => ({ line, what: why }));
