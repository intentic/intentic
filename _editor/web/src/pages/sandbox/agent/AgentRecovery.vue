<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHO PICKS A TURN BACK UP WHEN IT DIES THROUGH NO FAULT OF ITS OWN — and, at the end, who stops one that is
 * only ever going to die again. Both resumes are off until the owner asks for them: a re-run spends their
 * allowance on a turn they sent once, which is the same reason a spent usage limit is missing from the pair
 * entirely — it stops the turn, says when it resets, and leaves the next send to them. */

const { settings, patch } = useSandboxSettings();

// The spin-loop guard's threshold, as a count in the box. 0 is a real value here — it means "never quarantine"
// — so unlike the holdout boxes an emptied field cannot fall back to the saved number without making 0
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
             a person means inside one conversation is "finish this", and what they mean here is "this is how
             the board behaves". Conflating the two is how one midnight click used to sign every agent up.

             So the row states the two things a default owes its reader: what it governs (everything that has
             not answered for itself), and that some chats may have. -->
        <Row
            icon="refresh"
            title="Resume after provider outages, by default"
            description="Retry a turn the provider failed (500, at capacity, a dropped connection), backing off between attempts and trying one agent at a time."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.resumeAfterOutage ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ resumeAfterOutage: value })"
                />
            </template>
            <template #below>
                <p class="text-2xs text-muted">
                    The starting answer for every agent. One chat can be kept going on its own from the banner under the turn an outage killed, and a
                    chat that has answered for itself keeps its own answer whatever this switch says.
                </p>
            </template>
        </Row>

        <!-- Restart auto-resume — for the last thing that kills a turn nobody chose to kill: this sandbox
             restarting under it. Every update, environment approval and image rebuild recreates the container,
             so the common case is the user's OWN approval taking down the run that asked for it. -->
        <Row
            icon="refresh"
            title="Resume turns after a restart"
            description="When the sandbox restarts while an agent is mid-turn — an update, an approved environment change, a crash — pick that turn back up when it comes back."
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
            description="Disable an automation after this many failed runs in a row. 0 never disables one."
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
            <template #below>
                <p v-if="(settings?.automationFailureLimit ?? 0) > 0" class="text-2xs text-muted">
                    Only errored runs count — a guard skipping a run, or the daemon restarting under one, does not. The row says why it stopped, and
                    its switch turns it back on.
                </p>
            </template>
        </Row>
    </RowGroup>
</template>
