import type { RestartResume } from "../../agent/run/turn/recovery/restart-resume-policy.js";
import { type InFlight, type InFlightFailed, type LeftWork, readLeftWork, recoverLeftWork } from "./in-flight.js";

// A restart as a suite drives it: the kinds read, then recovered in the order given, under one restart answer, exactly as
// bootstrap/restart/in-flight-kinds.ts and boot-resumes.ts do at boot. A kind that fails to read or recover fails the suite.
const thrown: InFlightFailed = (kind, stage, error) => {
    throw new Error(`${kind}: the ${stage} failed`, { cause: error });
};

export const RESUMES: RestartResume = { resume: true, asked: false };

export const recoverKinds = async <Deps>(deps: Deps, kinds: readonly InFlight<Deps>[], resume: RestartResume = RESUMES): Promise<void> =>
    recoverLeftWork(await readLeftWork(deps, kinds, thrown), resume, thrown);

// The kinds read as the boot reads them, all before any is recovered, for a suite that does something between two of
// them (a turn the journal resumes, before the children it cut are settled).
export const readKinds = async <Deps>(deps: Deps, kinds: readonly InFlight<Deps>[]): Promise<readonly LeftWork[]> => readLeftWork(deps, kinds, thrown);
