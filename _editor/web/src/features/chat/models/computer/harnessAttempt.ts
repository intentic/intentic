import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { type HarnessAttempt, harnessAttempts } from "../../../../models/conversations/accounts/computerSignIn";
import type { ComputerHarness } from "../../../../models/providers/computer/computerHarnesses";

/* WHERE ONE CODING AGENT'S SET UP OR SIGN IN STANDS, IN WORDS (computerSignIn.ts runs it). One attempt per harness,
   whichever surface pressed: the picker's lane (ComputerLaneStatus.vue) and the gate above the composer
   (ComputerHarnessStrip.vue) say the same thing about it, in the same words. */

export interface HarnessAttemptView {
    readonly attempt: ComputedRef<HarnessAttempt | undefined>;
    /** Asked and not answered yet, or waiting on the browser on this computer. */
    readonly busy: ComputedRef<boolean>;
    /** What is happening meanwhile: fetching the agent (minutes), starting its sign-in, or waiting on the browser. */
    readonly working: ComputedRef<string>;
    /** The sign-in page's address, where the harness printed one. */
    readonly pageUrl: ComputedRef<string | undefined>;
    /** The press that unlocks it, whole ("Set up Codex on this computer"), and short, where its lane already names it. */
    readonly pressLabel: ComputedRef<string>;
    readonly shortLabel: ComputedRef<string>;
}

export const useHarnessAttempt = (harness: () => ComputerHarness | undefined): HarnessAttemptView => {
    const named = computed(() => ({ harness: harness()?.label ?? `` }));
    const settingUp = computed(() => harness()?.standing === `setUp`);
    const attempt = computed(() => {
        const id = harness()?.id;
        return id === undefined ? undefined : harnessAttempts.value[id];
    });
    return {
        attempt,
        busy: computed(() => attempt.value?.phase === `starting` || attempt.value?.phase === `waiting`),
        working: computed(() => {
            if (attempt.value?.phase === `waiting`) {
                return t(`chat.computer.harness.inBrowser`, named.value);
            }
            return settingUp.value ? t(`chat.computer.harness.settingUp`, named.value) : t(`chat.computer.harness.starting`, named.value);
        }),
        pageUrl: computed(() => (attempt.value?.phase === `waiting` && attempt.value.url !== `` ? attempt.value.url : undefined)),
        pressLabel: computed(() => (settingUp.value ? t(`chat.computer.harness.setUp`, named.value) : t(`chat.computer.harness.signIn`, named.value))),
        shortLabel: computed(() => (settingUp.value ? t(`chat.computer.picker.setUp`) : t(`chat.computer.picker.signIn`))),
    };
};
