import { computed, effectScope, type EffectScope, shallowRef, watch } from "vue";
import { router } from "../../../router";
import { type NotificationInput, useNotifications } from "../../../shell/notifications/notifications";
import { useSandbox } from "../client/useSandbox";
import { useHostHolding } from "../devices/useDevices";
import {
    type DevRebuildPhase,
    type DevRebuildRun,
    rebuildElapsedLabel,
    rebuildRunning,
    rebuildSeconds,
    useDevRebuild,
} from "../environment/useDevRebuild";
import { useSandboxVersion } from "../overview/version/useSandboxVersion";
import { SANDBOX_DEFAULT_SECTION } from "../sandboxNav";
import { useHostedBuild } from "../secrets/useHostedBuild";
import { restartFinished } from "./sandboxRestart";
import { t } from "@intentic/ui/i18n";

// THE RUNS THAT END IN A RESTART, FOLLOWED FROM THE ROOT. Everything here was already followed — by the Environment
// card, by the hub — and that was the whole problem: a build takes minutes, and the reader spends them somewhere
// else, so the one screen watching it was the one screen nobody was on. Mounted with the session (WorkspaceRuntime),
// this keeps the following alive wherever they went: the ledger armed while the work runs, so the lane and the gate
// can name the silence at the end of it, and the outcome delivered to wherever they are when it lands.

// The two sections that draw a rebuild in full — the Environment card and the update card on the default one, which
// is the same component twice. A receipt saying what the card beside it already says, in fewer words, is noise, so
// the one reader this stays quiet for is the one who never walked away.
const READING_IT = new Set([`environment`, SANDBOX_DEFAULT_SECTION, undefined]);
const onTheCard = (): boolean => {
    const route = router.currentRoute.value;
    const tab = route.params[`tab`];
    return route.name === `sandbox` && READING_IT.has(typeof tab === `string` && tab !== `` ? tab : undefined);
};

const openEnvironment = (): void => {
    void router.push({ name: `sandbox`, params: { tab: `environment` } });
};

const failureTitle = (run: DevRebuildRun): string => {
    if (run.phase === `lost`) {
        return `That rebuild stopped reporting, and never said how it ended.`;
    }
    return run.exitCode === undefined ? `That device didn't run the rebuild.` : `The rebuild failed on that device (exit ${run.exitCode}).`;
};

/**
 * The receipt a settled rebuild is worth, or nothing. Only the crossing counts: a run that was live and is not any
 * more happened while somebody was waiting on it, whereas a phase that was already settled is a fact this browser
 * read off a machine's old log, and announcing that would greet a reader with the result of somebody else's build.
 */
export const rebuildReceipt = (before: DevRebuildPhase | undefined, run: DevRebuildRun | undefined): Omit<NotificationInput, "kind"> | undefined => {
    if (run === undefined || before === undefined || !rebuildRunning(before) || rebuildRunning(run.phase) || run.phase === `idle`) {
        return undefined;
    }
    // The card keeps the durable record — the log, its path, the dismissal. This is only the sentence that finds
    // whoever left, which by the time a rebuild lands is nearly everyone.
    const seeTheLog = [{ label: t(`sandbox.restartWatch.seeLog`), severity: `secondary` as const, run: openEnvironment }];
    if (run.phase === `done`) {
        const took = rebuildElapsedLabel(rebuildSeconds(run));
        return {
            tone: `done`,
            title: `Rebuilt from your checkout in ${took ?? `a few minutes`}`,
            detail: t(`sandbox.restartWatch.youreRunningNewImage`),
            actions: seeTheLog,
        };
    }
    return { tone: `problem`, title: failureTitle(run), detail: run.trouble, actions: seeTheLog };
};

export const startRestartWatch = (): void => {
    const { activeSandboxId, active, reachable } = useSandbox();
    const { report } = useNotifications();
    const { slug, localImage } = useSandboxVersion();

    // The sandbox answered, so whatever restart this browser was waiting on has happened. Immediate as well as on
    // every change: a tab that opens onto a healthy sandbox is one whose stored expectations are already over.
    watch([reachable, activeSandboxId], ([up, id]) => {
        if (up) {
            restartFinished(id);
        }
    });
    restartFinished(reachable.value ? activeSandboxId.value : undefined);

    // Keeps a hosted sandbox's build status arriving while the reader is anywhere but the Environment card: the
    // composable arms the ledger itself, and it cannot do that from a screen nobody has open. Polls only while a
    // build is in flight, and asks nothing at all on the lane with no hosted machine.
    useHostedBuild(() => (active.value?.hosted ? active.value.id : undefined));

    // The rebuild's own follow. Same adoption the card does — a marker from before a reload, or a log still growing
    // because someone ran the rebuild in a terminal — done from here so it happens whether or not the card is open.
    const hostId = useHostHolding(
        () => slug.value,
        () => localImage.value?.root,
    );
    const followed = shallowRef<DevRebuildRun | undefined>(undefined);
    let scope: EffectScope | undefined;
    watch(
        [hostId, slug],
        ([id, name]) => {
            // The run itself is module state and survives this: what the scope owns is the clock that draws it.
            scope?.stop();
            scope = undefined;
            followed.value = undefined;
            if (id === undefined || name === undefined) {
                return;
            }
            scope = effectScope();
            scope.run(() => {
                const follower = useDevRebuild(name);
                follower.adopt(id);
                followed.value = follower.run;
            });
        },
        { immediate: true },
    );

    // The outcome, delivered to wherever the reader is — except the one screen that already draws it in full, where a
    // second, shorter copy of the same sentence would be noise.
    const phase = computed(() => followed.value?.phase);
    watch(phase, (_now, before) => {
        const receipt = rebuildReceipt(before, followed.value);
        if (receipt !== undefined && !onTheCard()) {
            report(receipt);
        }
    });
};
