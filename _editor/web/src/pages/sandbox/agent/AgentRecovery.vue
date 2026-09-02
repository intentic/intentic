<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHO PICKS A TURN BACK UP WHEN IT DIES THROUGH NO FAULT OF ITS OWN, and, at the end, who stops one that is
 * only ever going to die again. Every resume here is off until the owner asks for it, for one reason said three
 * times: a re-run spends their allowance on a turn they sent once, and only they can say whether it was worth
 * paying for twice.
 *
 * THE SPENT-ALLOWANCE ROW IS THE ODD ONE and worth the row it takes. The other two are guesses, a backoff at a
 * provider nobody can predict, a boot that may or may not have been the turn's fault; this one waits for an
 * hour the provider itself published and fires once, at it. It used to be absent from this group on the
 * grounds that the budget is the user's, which is an argument for the DEFAULT and was quietly serving as an
 * argument against the choice: the case it left unanswered is the 2am wall on a board nobody is watching, where
 * the alternative was a card that waited eight hours for a press that was always going to come. */

const { settings, patch } = useSandboxSettings();

// The spin-loop guard's threshold, as a count in the box. 0 is a real value here: it means "never quarantine"
//, so unlike the holdout boxes an emptied field cannot fall back to the saved number without making 0
// unreachable; it clamps to the bound instead, and the input is written back so a refused number doesn't stay
// on screen.
const setAutomationFailureLimit = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const automationFailureLimit = Math.min(20, Math.max(0, Math.round(Number(input.value) || 0)));
    input.value = String(automationFailureLimit);
    patch({ automationFailureLimit });
};
</script>

<template>
    <RowGroup label="When a turn breaks">
        <!-- THE DEFAULT, and the row says so in its own title. A single chat can answer this for itself from
             the banner under the turn that died, and that press deliberately does NOT reach this switch: what
             a person means inside one conversation is \"finish this\", and what they mean here is \"this is how
             the board behaves\". Conflating the two is how one midnight click used to sign every agent up.

             So the row states the two things a default owes its reader: what it governs (everything that has
             not answered for itself), and that some chats may have. -->
        <Row
            icon="refresh"
            title="Resume after provider outages, by default"
            description="Retry turns failed by the provider (500, capacity, connection drops)."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.resumeAfterOutage ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ resumeAfterOutage: value })"
                />
            </template>
        </Row>

        <!-- The allowance, which is the one wait in this group with an appointment rather than a guess: the
             provider says when the window reopens, and the turn goes again then, once. The description leads
             with that, because "retry" is what the row above does and would be the wrong word here. -->
        <Row
            icon="clock"
            title="Send again when the allowance comes back, by default"
            description="Re-run turns a spent usage limit refused, at the reset the provider named."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.resumeAfterLimit ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ resumeAfterLimit: value })"
                />
            </template>
        </Row>

        <!-- Restart auto-resume, for the last thing that kills a turn nobody chose to kill: this sandbox
             restarting under it. Every update, environment approval and image rebuild recreates the container,
             so the common case is the user's OWN approval taking down the run that asked for it. -->
        <Row
            icon="refresh"
            title="Resume turns after a restart"
            description="Pick up in-flight turns when the sandbox restarts."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.autoResumeOnRestart ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ autoResumeOnRestart: value })"
                />
            </template>
        </Row>

        <!-- The spin-loop guard, and the one row here that STOPS something rather than resuming it. A job that
             fails every time is misconfigured, and the scheduler will keep spending a turn on it every tick
             until somebody looks. 0 = never, and it is the default: an hourly poll against an API having a bad
             afternoon is broken for three fires and fine on the fourth, and an automation disabled at 3 a.m. is
             one nobody re-enables until they notice. -->
        <Row
            icon="stop"
            title="Stop a failing automation"
            description="Disable an automation after consecutive failures (0 never disables)."
        >
            <template #control>
                <input
                    type="number"
                    min="0"
                    max="20"
                    aria-label="Consecutive failures before an automation is disabled"
                    class="w-16 rounded-lg border border-line bg-canvas px-2 py-1 text-right text-xs text-content"
                    :value="settings?.automationFailureLimit ?? 0"
                    :disabled="settings === undefined"
                    @change="setAutomationFailureLimit"
                />
            </template>
        </Row>
    </RowGroup>
</template>
