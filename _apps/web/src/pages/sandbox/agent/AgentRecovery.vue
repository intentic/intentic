<script setup lang="ts">
import { Row, RowGroup } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

/* WHO PICKS A TURN BACK UP WHEN IT DIES THROUGH NO FAULT OF ITS OWN — and, at the end, who stops one that is
 * only ever going to die again. The two resumes are on by default; a spent usage limit is the case deliberately
 * missing from the pair, because that allowance is the user's own budget, so it stops the turn, says when it
 * resets, and leaves the next send to them. */

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
        <!-- The outage row is also offered from the chat at the moment it would have helped. -->
        <Row
            icon="refresh"
            title="Auto-resume after provider outages"
            description="When the model provider fails a turn (500, 529 at capacity, a dropped connection), retry it automatically — waiting longer between each attempt, and only one attempt at a time across all your agents, so an outage isn't hammered."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.resumeAfterOutage ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ resumeAfterOutage: value })"
                />
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
                    :model-value="settings?.autoResumeOnRestart ?? true"
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
        <Row icon="stop" title="Stop a failing automation" description="Disable an automation after this many failed runs in a row. 0 never disables one.">
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
