import { computed, ref, type Ref, watch } from "vue";
import { track } from "../../../app/analytics";
import { desktopSetupStopLink, openDesktopLink } from "../../../app/environments/desktop";
import type { DesktopSetupReport } from "../../../app/environments/desktopSetupReport";
import type { Handoff } from "./commandHandoff";

// CALLING THE APP'S INSTALL OFF FROM THIS PAGE (2026-10-21). "Set it up now" started a Docker install the page had no
// way back from, so a misclick cost the install. Its Cancel sends `intentic://setup-stop` (the app's setup.ts
// `stopForPage`: the run stops, or a setup waiting on this PC is given up) and hands the button back at once rather than
// when the app's word arrives. Held until the reader starts again: an app too old to hear the stop goes on reporting its
// run, and the page must not go on drawing it as under way.

export interface AppStopHost {
    readonly inApp: Readonly<Ref<boolean>>;
    readonly created: Readonly<Ref<{ readonly id: string } | null>>;
    // Set once the app is handed the code; cleared by the stop, so the app's bar and its handoff line go with it.
    readonly launched: Ref<boolean>;
    readonly handoff: Readonly<Ref<Handoff>>;
    readonly report: Readonly<Ref<DesktopSetupReport | undefined>>;
    // The app's install under way by its own account and the claim's (desktopSetup.ts `setupUnderWay`).
    readonly underWay: () => boolean;
    // A press on a connected machine is a start of its own: the stop said here was about the app's install.
    readonly machineRun: { readonly busy: Readonly<Ref<boolean>> };
    readonly runHere: () => void;
}

export const useAppStop = ({ inApp, created, launched, handoff, report, underWay, machineRun, runHere }: AppStopHost) => {
    const stopped = ref(false);
    const installUnderWay = computed(() => !stopped.value && underWay());
    // One this page handed the app, or one the app reports; only from inside the app, the one place the link is heard.
    const stoppable = computed(() => inApp.value && installUnderWay.value && (launched.value || report.value !== undefined));
    watch(machineRun.busy, (busy) => {
        if (busy) {
            stopped.value = false;
        }
    });
    const start = (): void => {
        stopped.value = false;
        runHere();
    };
    const stop = (): void => {
        const id = created.value?.id;
        if (id === undefined) {
            return;
        }
        track(`desktop_setup_cancelled`, {
            state: report.value?.state ?? null,
            percent: report.value?.percent ?? null,
            claimed: handoff.value === `claimed`,
        });
        openDesktopLink(desktopSetupStopLink(id));
        stopped.value = true;
        launched.value = false;
    };
    return { stopped, installUnderWay, stoppable, start, stop };
};

export type AppStopApi = ReturnType<typeof useAppStop>;
