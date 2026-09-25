import type { SandboxSettings } from "@intentic/api-contract";
import type { OffloadKind, OffloadRecord } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";
import { kindTitle } from "../../agent-settings/behaviour/offloadRows";

// What a runner's row says about the work this sandbox sends it (settings `offload`): which kinds go there, and how the
// last offloaded run there ended. Empty for a runner nothing is sent to, which then reads as it always did.

// The kinds sent to `runner`, in words, with the check after landing last.
export const sentTo = (runner: string, offload: SandboxSettings[`offload`] | undefined, kinds: readonly OffloadKind[]): string[] => {
    if (offload === undefined) {
        return [];
    }
    const titled = Object.entries(offload.commands)
        .filter(([, target]) => target === runner)
        .map(([id]) => kindTitle(kinds.find((kind) => kind.id === id) ?? { id, pattern: `` }));
    return offload.landCheck === runner ? [...titled, t(`sandbox.agentOffload.landCheck`)] : titled;
};

// The newest run offloaded to `runner`, as one line: what it was and how it ended, or that it is still going.
export const lastRun = (runner: string, runs: readonly OffloadRecord[]): string | undefined => {
    const run = runs.find((entry) => entry.runner === runner);
    if (run === undefined) {
        return undefined;
    }
    if (run.endedAt === undefined) {
        return t(`sandbox.agentOffload.lastRunGoing`, { command: run.command });
    }
    return run.failure === undefined && run.code === 0
        ? t(`sandbox.agentOffload.lastRunPassed`, { command: run.command })
        : t(`sandbox.agentOffload.lastRunFailed`, { command: run.command, code: String(run.code ?? `?`) });
};
