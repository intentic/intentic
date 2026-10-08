import { errorMessage } from "@intentic/base/errors";
import { useNow } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { hold, useNotifications } from "../../../../workbench/notifications/notifications";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { expectRestart } from "../../live/sandboxRestart";
import { autoUpdateNotice } from "./autoUpdate";
import { useAutoUpdate } from "./useAutoUpdate";
import { useSandboxVersion } from "./useSandboxVersion";

// AN UPDATE THAT TAKES ITSELF, FOLLOWED FROM THE ROOT. The daemon only restarts when nobody it can see is at the editor,
// but "nobody it can see" is a judgement, and a person reading without touching anything looks the same as an empty
// room. So the countdown is said wherever the reader is, with the two answers that matter (not now, or now), and the
// silence that follows is named as the restart it is rather than read as an outage. Mounted with the session
// (WorkspaceRuntime), beside the restart watch, for the same reason: the update card is the one screen nobody is on.

export const startAutoUpdateWatch = (): void => {
    const { activeSandboxId, reachable } = useSandbox();
    const { auto, canSteer, notNow, applyNow } = useAutoUpdate();
    const { installed } = useSandboxVersion();
    const { report } = useNotifications();

    // The countdown's clock ticks only while there is one to draw.
    const counting = computed(() => auto.value?.phase === `countdown`);
    const clock = useNow(counting);

    // A press that the daemon refused (the update was taken back, the machine left) says why, and nothing else moves.
    const steer = async (action: () => Promise<void>, failed: string): Promise<void> => {
        try {
            await action();
        } catch (error) {
            report({ tone: `problem`, title: failed, detail: errorMessage(error) });
        }
    };

    // Only while the sandbox answers: once it goes quiet, the restart ledger's own card says what the silence is.
    hold(`auto-update`, () => {
        const notice = reachable.value ? autoUpdateNotice(auto.value, clock.value) : undefined;
        if (notice === undefined) {
            return undefined;
        }
        return {
            kind: `condition`,
            tone: `info`,
            icon: notice.counting ? `clock` : `refresh`,
            spin: notice.spin,
            title: notice.title,
            detail: notice.detail,
            ...(notice.counting && canSteer.value
                ? {
                      actions: [
                          { label: t(`sandbox.autoUpdate.notNow`), tier: `boring` as const, run: () => steer(notNow, t(`sandbox.autoUpdate.couldntChange`)) },
                          { label: t(`sandbox.autoUpdate.updateNow`), run: () => steer(applyNow, t(`sandbox.autoUpdate.couldntUpdate`)) },
                      ],
                  }
                : {}),
        };
    });

    // The restart, expected from the moment the daemon hands itself to the machine: the lane and the gate then say
    // "updating" through the half minute it is down, instead of an outage. Held until the sandbox answers again, or
    // until the daemon says it is not restarting after all (the machine answered in words).
    let settle: (() => void) | undefined;
    // The version this page saw it leave for, so the one that comes back can be told apart from any other reload.
    let leaving: { readonly from: string | undefined } | undefined;
    watch(
        () => [auto.value?.phase, activeSandboxId.value] as const,
        ([phase, sandbox]) => {
            if (phase === `updating` && sandbox !== undefined) {
                leaving ??= { from: installed.value };
                settle ??= expectRestart({
                    sandbox,
                    id: `update`,
                    what: t(`sandbox.autoUpdate.updatingTitleUnnamed`),
                    quiet: { title: t(`sandbox.autoUpdate.updatingTitleUnnamed`), detail: t(`sandbox.autoUpdate.updatingDetail`) },
                    untilAnswered: true,
                });
                return;
            }
            if (phase !== undefined && reachable.value) {
                settle?.();
                settle = undefined;
                // Still on the version it left: the machine answered in words, so no update of its own came back.
                if (leaving !== undefined && installed.value === leaving.from) {
                    leaving = undefined;
                }
            }
        },
        { immediate: true },
    );

    // Back on a newer version than the one it left: a receipt, for whoever is here to see it. The card keeps the record.
    watch(installed, (version) => {
        if (leaving === undefined || version === undefined || version === leaving.from) {
            return;
        }
        leaving = undefined;
        report({
            tone: `done`,
            title: t(`sandbox.autoUpdate.receiptTitle`, { version }),
            detail: t(`sandbox.autoUpdate.receiptDetail`),
        });
    });
};
