<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";

// Who resumes a turn that died through no fault of its own, and who stops one that will only die again.
// Every resume defaults to off: a re-run spends the owner's allowance on a turn already sent once.

const { settings, patch } = useSandboxSettings();

// 0 is a real value (never carry); an emptied field clamps to the bound rather than falling back to the saved
// number, and the input is written back so a refused value doesn't linger.
const setLimitMoveCarryUnder = (event: Event): void => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) {
        return;
    }
    const limitMoveCarryUnder = Math.max(0, Math.round(Number(input.value) || 0));
    input.value = String(limitMoveCarryUnder);
    patch({ limitMoveCarryUnder });
};

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
        <!--
            The default; a chat's own retry banner doesn't touch this switch, since "finish this turn" and "this is how
            the board behaves" are different questions. Governs everything that hasn't answered for itself.
        -->
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

        <!--
            The one wait here with a known reopen time (the provider names it) rather than a guess; described as "send
            again", not "retry", to keep the distinction.
        -->
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

        <!--
            The non-waiting answer to the same limit: moves to another connected account of the same provider with room.
            Opt-in since it spends a second account on the owner's behalf; with none available, it waits as the row above.
        -->
        <Row
            icon="user"
            title="Continue on another account when the allowance is spent, by default"
            description="Move a refused turn to a connected account of the same provider that has room, at once. With none, it waits as above."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.moveAfterLimit ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ moveAfterLimit: value })"
                />
            </template>
        </Row>

        <!--
            Carrying re-reads the whole context once and keeps what the model knew; starting fresh costs the measured
            brief plus a capped copy and loses the rest. Threshold in tokens; 0 always starts fresh.
        -->
        <Row
            icon="clock"
            title="Carry the session when its context is under"
            description="Tokens. Under this a move keeps the session (re-reads it once, cold); at or above it a fresh session starts from the measured brief. 0 always starts fresh."
        >
            <template #control>
                <input
                    type="number"
                    min="0"
                    step="1000"
                    aria-label="Context size, in tokens, under which a moved turn keeps its session"
                    class="ui-field-box ui-field-sm w-24 text-right"
                    :value="settings?.limitMoveCarryUnder ?? 100000"
                    :disabled="settings === undefined"
                    @change="setLimitMoveCarryUnder"
                />
            </template>
        </Row>

        <!--
            Covers a turn killed by the sandbox's own restart: an update, an environment approval, or an image rebuild.
            The common case is the user's own approval taking down the run that asked for it.
        -->
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

        <!--
            The one row here that stops rather than resumes: a job failing every run is misconfigured, and the scheduler
            would otherwise spend a turn on it every tick. 0 (never) is the default.
        -->
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
                    class="ui-field-box ui-field-sm w-16 text-right"
                    :value="settings?.automationFailureLimit ?? 0"
                    :disabled="settings === undefined"
                    @change="setAutomationFailureLimit"
                />
            </template>
        </Row>
    </RowGroup>
</template>
