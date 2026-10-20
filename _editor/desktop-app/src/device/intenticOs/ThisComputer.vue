<script setup lang="ts">
import { Section } from "@intentic/ui";
import { usePoll } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted } from "vue";
import { onScreen } from "../../onScreen";
import DisplayCard from "./DisplayCard.vue";
import DrivesCard from "./DrivesCard.vue";
import { drives, loadDrives } from "./drives";
import KeyboardCard from "./KeyboardCard.vue";
import NetworkCard from "./NetworkCard.vue";
import { displays, keyboard, loadSettings, network, sound } from "./settings";
import SoundCard from "./SoundCard.vue";

// THIS COMPUTER, on This device when it runs Intentic OS (DeviceView.vue mounts it under the This system card): the
// network, the sound, the screens, the keyboard and the drives plugged in, each a card of its own that shows once ic has
// said what it is, and none on a computer where ic says there is nothing (the screens and the keyboard on the server
// edition). What they show is read as the page opens and again every few seconds while it is on screen, since a cable
// pulled or a volume key pressed changes it from outside; the drives come from the app's own watcher as they change.

const t = useT();

/** How often what the cards show is read again while on screen: each read is a few quick `ic os` calls. */
const SETTINGS_EVERY_MS = 10_000;

const reading = usePoll({ everyMs: SETTINGS_EVERY_MS, visible: onScreen, check: loadSettings });
onMounted(() => {
    void loadDrives();
    reading.start();
});

const shown = computed(
    () => network.value !== undefined || sound.value !== undefined || displays.value !== undefined || keyboard.value !== undefined || drives.value !== undefined,
);
</script>

<template>
    <Section v-if="shown" data-this-computer :label="t(`desktop.os.thisComputer`)" :heading="2">
        <div class="flex flex-col gap-3">
            <NetworkCard v-if="network" />
            <SoundCard v-if="sound" />
            <DisplayCard v-if="displays && displays.outputs.length > 0" />
            <KeyboardCard v-if="keyboard" />
            <DrivesCard v-if="drives" />
        </div>
    </Section>
</template>
