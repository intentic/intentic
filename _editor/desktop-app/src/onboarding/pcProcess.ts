import type { ProcessReport } from "@intentic/web/process-report";
import { LOCAL_NAVIGATE_EVENT } from "@intentic/web/local";
import { computed, ref, watch } from "vue";
import { onboardingRestart, onboardingSetUp, onboardingSignOut, type OnboardingSetup } from "../desktop";
import { answering, processOf, tellProcess } from "../processes";
import { followPcSetup, NEW_SANDBOX_HOSTED_PATH, setUpThisPc } from "./pc";

// THIS PC'S OWN SETUP AS A PROCESS (2026-10-26; src-tauri/src/processes.rs): Docker and WSL being set up, on both faces'
// rails while it runs, waits on Windows or the reader, or has stopped; done until the reader puts it away, when this
// window saw it run. Its questions (go ahead, restart, sign out, try again) are answered where the reader is; This
// computer's card still draws it in full. Started by the main window, which follows this PC's setup (useDevice.ts).

/** This PC's setup as a process, or nothing while it rests unasked. `ranHere`: this window saw it run. Pure. */
export const pcProcessOf = (setup: OnboardingSetup, ranHere: boolean): ProcessReport | undefined => {
    const base = processOf(`pc-setup`, `this`, `running`);
    switch (setup.state) {
        case `running`:
            return {
                ...base,
                percent: setup.percent,
                step: setup.step,
                line: setup.reading ?? setup.row,
                state: setup.needsYou === true ? `waiting` : `running`,
                waitingFor: setup.needsYou === true ? `answer` : undefined,
            };
        case `waiting`:
            switch (setup.for) {
                case `admin`:
                    return { ...base, state: `waiting`, waitingFor: `consent`, actions: [`consent`, `use-hosted`] };
                case `restart`:
                    return { ...base, state: `waiting`, waitingFor: `restart`, actions: [`restart-now`, `restart-in-10`, `restart-later`, `use-hosted`] };
                case `signOut`:
                    return { ...base, state: `waiting`, waitingFor: `signOut`, actions: [`sign-out`, `use-hosted`] };
            }
            return undefined;
        case `failed`:
            return { ...base, state: `failed`, failure: setup.reason, actions: [`retry`, `use-hosted`, `dismiss`] };
        case `ready`:
            return ranHere ? { ...base, state: `done`, actions: [`dismiss`] } : undefined;
        case `idle`:
            return undefined;
    }
};

const ranHere = ref(false);
const dismissed = ref(false);

let started = false;

/** This PC's setup told and answered from now on. Once. */
export const tellPcSetup = (): void => {
    if (started) {
        return;
    }
    started = true;
    const setup = followPcSetup();
    watch(
        () => setup.value.state,
        (state) => {
            if (state === `running`) {
                ranHere.value = true;
                dismissed.value = false;
            }
        },
        { immediate: true },
    );
    const process = computed(() => (dismissed.value ? undefined : pcProcessOf(setup.value, ranHere.value)));
    watch(process, (current) => tellProcess(`pc-setup:this`, current), { immediate: true });
    answering(`pc-setup`, async (act) => {
        switch (act) {
            case `consent`:
                return await setUpThisPc(`process`);
            case `retry`:
                return await onboardingSetUp(true);
            case `restart-now`:
                return await onboardingRestart(`now`);
            case `restart-in-10`:
                return await onboardingRestart(`in10Minutes`);
            case `restart-later`:
                return await onboardingRestart(`later`);
            case `sign-out`:
                return await onboardingSignOut();
            // Asked of This computer (the workspace answers its own in place, on Home): its new sandbox's page, in this
            // face, which is where the press was made.
            case `use-hosted`:
                window.dispatchEvent(new CustomEvent(LOCAL_NAVIGATE_EVENT, { detail: { path: NEW_SANDBOX_HOSTED_PATH } }));
                return;
            case `dismiss`:
                dismissed.value = true;
                return;
            default:
                return;
        }
    });
};
