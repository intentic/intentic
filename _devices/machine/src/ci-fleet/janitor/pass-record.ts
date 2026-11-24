import type { CiFleetPass } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { FleetContext } from "../context.js";

/* ONE PASS OF THE JANITOR OR THE HOST PRUNE AS IT GOES: its lines, each also said to the service's log under the round's
   name (the journal keeps them, as it kept the scripts' output), and what it freed. Finished into the contract's
   CiFleetPass for the status and the socket. */

export interface PassRecord {
    readonly dryRun: boolean;
    readonly lines: string[];
    freedBytes: number;
    readonly say: (line: string) => void;
}

export const newPassRecord = (context: FleetContext, round: string, dryRun: boolean): PassRecord => {
    const lines: string[] = [];
    return {
        dryRun,
        lines,
        freedBytes: 0,
        say: (line) => {
            lines.push(line);
            context.log(`${round}${dryRun ? " (dry run)" : ""}: ${line}`);
        },
    };
};

export const finishPass = (context: FleetContext, record: PassRecord): CiFleetPass => ({
    at: new Date(context.sys.now()).toISOString(),
    dryRun: record.dryRun,
    freedBytes: Math.max(0, Math.round(record.freedBytes)),
    lines: record.lines,
});
