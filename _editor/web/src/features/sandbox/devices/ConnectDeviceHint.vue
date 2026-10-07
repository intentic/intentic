<!-- The line that turns a command block into a way out. -->
<script setup lang="ts">
import { computed } from "vue";
import { hostEntry } from "./deviceFacts";
import { capabilityRoute } from "./deviceLinks";
import { deviceNotListing, deviceSyncingSandbox } from "./deviceRows";
import { useDevices } from "./useDevices";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const props = defineProps<{
    /** This sandbox's container slug; the pairing is matched against it. */
    slug: string | undefined;
    /** What connecting it would buy, in the words of the card that shows this. */
    gains: string;
}>();

// Shares the Devices query without polling it: this is a sentence, not a monitor.
const { devices } = useDevices({ poll: false });
const machine = computed(() => deviceSyncingSandbox(devices.value, props.slug));
const card = computed(() => (machine.value === undefined ? undefined : hostEntry(machine.value.platform)));
// Already connected, and the reason this is still a command is the machine's own: it did not list its sandboxes.
const unlisted = computed(() => deviceNotListing(devices.value));
</script>

<template>
    <p v-if="machine && card" class="text-2xs text-subtle">
        <!-- Use the device name because the user may have multiple machines. -->
        <span class="font-mono">{{ machine.label }}</span>
        {{ t(`sandbox.connectDeviceHint.syncsSandboxNotConnected`) }}
        <RouterLink :to="capabilityRoute(card, { device: machine.label })" class="text-link hover:underline">
            {{ t(`sandbox.connectDeviceHint.connect`) }}
        </RouterLink>
        {{ t(`sandbox.connectDeviceHint.and`) }} {{ gains }}
    </p>
    <p v-else-if="unlisted" class="text-2xs text-subtle">
        <span class="font-mono">{{ unlisted.label }}</span>
        {{ t(`sandbox.connectDeviceHint.connectedButNotListing`) }}
        <span class="font-mono break-words">{{ unlisted.sandboxesUnread }}</span>
    </p>
</template>
