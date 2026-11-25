<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { computed } from "vue";
import { startHarness } from "../../../../models/conversations/accounts/computerSignIn";
import { computerHarness } from "../../../../models/providers/computer/computerHarnesses";
import { useHarnessAttempt } from "./harnessAttempt";

// A LOCKED LANE'S PRESS, WHERE THE CODING AGENT IS THIS COMPUTER'S (ModelPicker.vue `lane-action`): at the end of its
// header, where a sandbox's lane has its Connect, and drawn the same: "Set up" for a program not on this computer yet,
// "Sign in" for one signed out. It starts the attempt here and now (computerSignIn.ts), since there is no page to send the
// reader to; how it goes is the lane's own line under the header (ComputerLaneStatus.vue). A program whose sign-in the
// sidecar cannot run has no press: its line says to sign in from a terminal.

const { provider } = defineProps<{ provider: AgentProvider }>();

const harness = computed(() => computerHarness(provider));
const { busy, pressLabel, shortLabel } = useHarnessAttempt(() => harness.value);
</script>

<template>
    <button
        v-if="harness !== undefined && harness.asked && !busy"
        type="button"
        class="text-2xs text-link hover:underline"
        :aria-label="pressLabel"
        data-harness-press
        @click="startHarness(provider)"
    >
        {{ shortLabel }}
    </button>
</template>
