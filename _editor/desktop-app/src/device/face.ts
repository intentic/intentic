import type { DeviceSandboxGroup, SandboxMenuVerb } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { computed, type ComputedRef } from "vue";
import { intoWorkspace } from "../account";
import { engineBackShown, engineState, moveEngine } from "./engine/engine";
import { moveTargetOf } from "./engine/engineMove";
import { agentPanel, sandboxes } from "./machine";
import { signedIn } from "./roster";

// WHAT THE DEVICES PAGE PUTS ON ITS FACE, and what it keeps behind a ⋯ (DeviceView.vue).
//
// The masthead is said once. A healthy agent is a green word with its build on that word's hover, and Restart waits behind
// the ⋯ beside it: a version and a verb in full beside a machine that is fine were the loudest things on the page. A
// stalled or stopped agent gets its build and its Restart back on the face, where the trouble is. The move back to Docker
// Desktop rides the same ⋯: it used to be the page's only link, at its foot, so the one thing that looked pressable on
// the whole page was a step backwards.

/** The agent answers and runs its rounds: nothing about it needs the reader. */
export const agentSettled = computed(() => agentPanel.value?.state.variant === `success`);

/** The masthead's ⋯: Restart while the agent is settled, and the move back to Docker Desktop while it is on offer. */
export const useMastheadMenu = (restart: () => Promise<void>): ComputedRef<SandboxMenuVerb[]> =>
    computed(() => {
        const verbs: SandboxMenuVerb[] = agentSettled.value
            ? (agentPanel.value?.actions ?? []).map((action) => ({ label: action.label, icon: `refresh`, run: () => void restart() }))
            : [];
        const state = engineState.value;
        if (engineBackShown.value && state !== undefined) {
            verbs.push({
                label: t(`desktop.engine.moveBack`),
                icon: `box`,
                hint: t(`desktop.engine.runsOn.intentic`),
                run: () => void moveEngine(moveTargetOf(state) ?? `docker-desktop`, false),
            });
        }
        return verbs;
    });

// OPEN, the one verb a sandbox card shows: the workspace on that sandbox, by the id the platform knows it by (what its
// last announce named). Only for one that answers, or wakes when opened; a stopped one shows Start instead.
const platformIdOf = (group: DeviceSandboxGroup): string | undefined =>
    sandboxes.value.find((sandbox) => sandbox.slug === group.sandbox?.slug)?.platformId ?? undefined;

export const openable = (group: DeviceSandboxGroup): boolean =>
    signedIn.value === true && platformIdOf(group) !== undefined && (group.sandbox?.running === true || group.sandbox?.asleep === true);

export const openSandbox = async (group: DeviceSandboxGroup): Promise<void> => {
    const id = platformIdOf(group);
    if (id !== undefined) {
        await intoWorkspace(`/?${new URLSearchParams({ sandbox: id }).toString()}`);
    }
};
