import { refuse } from "@intentic/contract-serve";
import { choresReport, reprobe, writeLedger } from "../../fixture/chores";
import { type Doors, okAfter } from "../doors";

// How long a retaken probe (pnpm audit, knip, the churn read) takes here before its reading moves.
const PROBE_MS = 2_500;

// GET /chores computes rows in the browser from fixture/chores.ts; the ledger and the probes' clocks are real state.
export const choresDoors = {
    list: () => choresReport(Date.now()),
    record: (entry) => okAfter(() => writeLedger(Date.now(), entry)),
    probe: async ({ repo, id }) => {
        await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
        if (!reprobe(Date.now(), repo, id)) {
            refuse(`No ${id} probe is measured on ${repo}.`, 404);
        }
        return { ok: true as const };
    },
} satisfies Doors<`chores`>;
