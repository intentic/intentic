import { localHost } from "@intentic/web/local-host";
import { computed } from "vue";
import { facts, info } from "../machine";
import { signedIn } from "../roster";
import { carriesMove, pcCardPhase, type PcCardPhase } from "./pcCard";

// The card for this PC's own setup as this window has it, from what the app last said: the card draws it
// (PcSetupCard.vue), and what else This computer says stands back while it is up (DeviceView.vue's no-sandbox card), so
// the reader is told one way forward, not two.

export const pcCard = computed((): PcCardPhase => {
    const onboarding = localHost().onboarding;
    return pcCardPhase({
        os: info.value?.os,
        check: onboarding?.check.value,
        setup: onboarding?.setup.value ?? { state: `idle` },
        signedIn: signedIn.value,
        hostsSandboxes: facts.value?.hostsSandboxes === true,
        firstTask: onboarding?.firstTask.value,
    });
});

/** The card is on This computer: anything from "Checking this PC…" to the first task that did not start. */
export const pcCardShown = computed(() => pcCard.value !== `hidden`);

/** The card carries the move of this PC's sandboxes, and This computer's engine card stands back (pcCard.ts `carriesMove`). */
export const pcCarriesMove = computed(() => carriesMove(pcCard.value, localHost().onboarding?.check.value));
