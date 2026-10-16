// What home-dir.mjs reads a file for, kept callable on bare text so its suite can feed it some.
import { doorRule } from "../doors.rules.mjs";
import { findSites } from "./doors.mjs";

/** The 1-based line of each `homedir(` in `text`. */
export const homeDirCalls = (text) => findSites(doorRule(`home-dir`), ``, text).sites.map(({ line }) => line);
