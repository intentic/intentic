<!--
    The line that turns a command block into a way out. Anything that has to happen outside this container — a
    container restart, an image swap, a script in the checkout it was launched from — is ours to run only on a machine
    connected as a device. When the machine holding this sandbox's sync pairing is not one, the command below is the
    fallback and this says what would remove it.

    Silent whenever there is nothing to offer: no such machine, or a platform with no card to connect it on.
-->
<script setup lang="ts">
import { computed } from "vue";
import { hostCard } from "./deviceFacts";
import { deviceSyncingSandbox } from "./deviceRows";
import { useDevices } from "./useDevices";

const props = defineProps<{
    /** This sandbox's container slug; the pairing is matched against it. */
    slug: string | undefined;
    /** What connecting it would buy, in the words of the card that shows this. */
    gains: string;
}>();

// Shares the Devices query without polling it: this is a sentence, not a monitor.
const { devices } = useDevices({ poll: false });
const machine = computed(() => deviceSyncingSandbox(devices.value, props.slug));
const card = computed(() => (machine.value === undefined ? undefined : hostCard(machine.value.platform)));
</script>

<template>
    <p v-if="machine && card" class="text-2xs text-subtle">
        <!--
            Named, not "your machine": the reader has more than one, and this is the only one the sentence is true of.
        -->
        <span class="font-mono">{{ machine.label }}</span>
        syncs this sandbox but is not connected as a device.
        <RouterLink :to="{ name: `capabilities`, params: { card }, query: { device: machine.label } }" class="text-link hover:underline">
            Connect it
        </RouterLink>
        and {{ gains }}
    </p>
</template>
