import type { SandboxSummary } from "@intentic/api-contract";
import { onScopeDispose, ref, type Ref } from "vue";
import { track } from "../../../app/analytics";
import type { useSandbox } from "../../sandbox/client/useSandbox";
import type { HostedWaitView } from "../hostedWait";
import { setupReportView } from "../setupReport";
import type { HostedLane } from "./hostedLane";
import type { Machine } from "./machineLadder";
import type { SetupRow } from "./useSetupRow";

// Watches the registry while the reader sits on /setup, every few seconds and on every return to the tab: records what
// it says about the row (a redeemed code, the machine's report, the daemon's check-ins, the hosted machine's power) and
// opens the workspace the moment the daemon reports in past the baseline.

type SandboxStore = ReturnType<typeof useSandbox>;

// Between two registry reads (ms).
const POLL_MS = 3_000;

export interface RegistryWatchHost {
    readonly sandbox: Pick<SandboxStore, `refresh`>;
    readonly row: SetupRow;
    readonly hosted: {
        readonly machine: Readonly<Ref<Machine>>;
        readonly lane: Readonly<Ref<HostedLane>>;
        readonly hostedRow: Readonly<Ref<SandboxSummary[`hosted`]>>;
        readonly hostedWait: Readonly<Ref<HostedWaitView>>;
        readonly readMachine: (sandboxId: string, action: number) => Promise<void>;
    };
    // The key of the code the command on screen carries.
    readonly mintedFor: Readonly<Ref<string | undefined>>;
}

export const useRegistryWatch = ({ sandbox, row, hosted, mintedFor }: RegistryWatchHost) => {
    // Why the wait is stuck, or undefined; a stuck wait names its cause instead of spinning silently.
    const status = ref<string | undefined>(undefined);
    // Keeps the interval from stacking requests; deliberately not drawn.
    let checking = false;

    // An answer asked before the machine was replaced or a hand-back began describes a machine nobody waits on.
    const superseded = (action: number): boolean => action !== hosted.lane.value.action || hosted.lane.value.kind === `releasing`;

    // The command's half, recorded only for the code on screen: a redeemed code and the machine's account of its run.
    const recordCommand = (found: SandboxSummary | undefined): void => {
        const claim = found?.setupCodeClaimedAt ?? null;
        if (claim !== null && row.claimedAt.value === null) {
            // The funnel's missing middle, the command pasted: a drop-off after it and before `sandbox_connected` is Docker's.
            track(`sandbox_command_claimed`, { resuming: row.resuming.value });
        }
        row.claimedAt.value = claim;
        const reported = found?.setupReport ?? null;
        if (reported !== null && reported.failed.length > 0 && setupReportView(row.report.value).failures === null) {
            // Setup failed with a named cause, rather than a silent drop-off between the claim and a check-in.
            track(`sandbox_setup_failed`, { stage: reported.stage, checks: reported.failed.map((failure) => failure.check).join(`,`) });
        }
        row.report.value = reported;
    };

    // What the sandbox has said about itself since: the hosted wait card's two other sources.
    const recordBoot = (found: SandboxSummary | undefined): void => {
        row.bootReport.value = found?.bootReport ?? null;
        row.announceRefusal.value = found?.announceRefusal ?? null;
        row.announced.value = (found?.lastSeenAt ?? null) !== null;
    };

    // Holds the hosted lane on its card until the daemon is reachable (a check-in only proves a start) and its boot
    // chain has converged: handing over sooner lands on a second card that repeats this one.
    const holding = (): boolean =>
        hosted.hostedRow.value !== null && (hosted.hostedWait.value.reachable === false || hosted.hostedWait.value.booting);

    // On the own-computer rung, a row re-issued to another token, or carrying a machine, is not the one set up here.
    const foreign = (pending: SandboxSummary, found: SandboxSummary | undefined): boolean =>
        hosted.machine.value === `mine` && (found?.token !== pending.token || found?.hosted != null);

    // The daemon checked in past the baseline, and nothing holds the lane on its card.
    const arrived = (found: SandboxSummary | undefined): boolean => {
        const seen = found?.lastSeenAt ?? null;
        return seen !== null && seen !== row.baseline.value && !holding();
    };

    // One registry reading of the row this page waits on, under the code and the action it was asked with.
    const read = async (pending: SandboxSummary, found: SandboxSummary | undefined, askedFor: string | undefined, action: number): Promise<void> => {
        if (foreign(pending, found)) {
            return;
        }
        if (askedFor === mintedFor.value) {
            recordCommand(found);
        }
        recordBoot(found);
        // Asked only during a hosted wait, and less often than the registry; a failed read keeps the last answer.
        if ((found?.hosted ?? null) !== null) {
            await hosted.readMachine(pending.id, action);
        }
        if (!superseded(action) && arrived(found)) {
            await row.connected(pending.id);
        }
    };

    // Looks the row up by id in the fresh list, never through the active sandbox, which can point elsewhere mid-wait.
    const check = async (): Promise<void> => {
        const pending = row.created.value;
        if (pending === null || checking || hosted.lane.value.asked === `release`) {
            return;
        }
        // An answer after a re-mint must not report the previous command as claimed.
        const askedFor = mintedFor.value;
        const { action } = hosted.lane.value;
        checking = true;
        try {
            const live = await sandbox.refresh();
            // Rows can switch while the registry answers, as well as machines.
            if (superseded(action) || pending.id !== row.created.value?.id) {
                return;
            }
            // A reachable platform clears an earlier "can't reach" warning: it must not outlive its cause.
            status.value = undefined;
            await read(
                pending,
                live.find((entry) => entry.id === pending.id),
                askedFor,
                action,
            );
        } catch {
            status.value = `Can't reach the platform to check. Retrying…`;
        } finally {
            checking = false;
        }
    };

    const timer = setInterval(() => void check(), POLL_MS);
    // A hidden tab (the whole install, inside the app) throttles the interval to far longer, so a return checks at once.
    const recheck = (): void => {
        if (document.visibilityState === `visible`) {
            void check();
        }
    };
    document.addEventListener(`visibilitychange`, recheck);
    window.addEventListener(`focus`, recheck);
    onScopeDispose(() => {
        clearInterval(timer);
        document.removeEventListener(`visibilitychange`, recheck);
        window.removeEventListener(`focus`, recheck);
    });

    return { status, check };
};
