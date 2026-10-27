import { DEMO_RUN_TARGETS } from "../account/settings";
import type { Doors } from "../doors";

// A repository's "Run on <device>" dialog. A start answers the terminal session the build and the launch run in, named as
// the daemon names a run's job session, for the editor to open.
export const runsDoors = {
    targets: () => DEMO_RUN_TARGETS,
    start: ({ repo, target, device }) => ({ session: `run-${repo}-${target}-${device}`.replaceAll(/[^a-zA-Z0-9_-]/gu, `-`) }),
} satisfies Doors<`runs`>;
