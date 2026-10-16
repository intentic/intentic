<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { readAloud } from "./readAloud";
import { useSpeechPlayer } from "../../../models/voice/speechPlayer";

// Reads one reply aloud, whole: its code announced rather than spelled, its paths and links shortened (the sandbox's
// voice-text.ts). One press reads it, the next stops it. The press shows THAT it took (a spinner, then Stop); the card in
// the notification lane says WHAT is happening in words (readAloud.ts), since the wait for a first word can be long.

const props = defineProps<{
    /** The reply as written. */
    text: string;
    /** Which reply: what the page's one player holds while it reads this one. */
    readKey: string | number;
}>();

const t = useT();
const player = useSpeechPlayer();
const key = computed(() => `read:${props.readKey}`);
const mine = computed(() => player.speaking.value === key.value);
const loading = computed(() => mine.value && player.state.value !== `speaking`);

const hint = computed(() => {
    if (!mine.value) {
        return t(`chat.readAloud.read`);
    }
    if (player.state.value === `downloading`) {
        return t(`chat.readAloud.downloading`, { percent: Math.round((player.progress.value ?? 0) * 100) });
    }
    return loading.value ? t(`chat.readAloud.preparing`) : t(`chat.readAloud.stop`);
});

const toggle = (): void => {
    if (mine.value) {
        player.stop();
        return;
    }
    void readAloud(props.text, key.value, player);
};
</script>

<template>
    <button
        type="button"
        :class="ui.iconButton({ size: `sm`, tone: `subtle` })"
        :aria-pressed="mine"
        :aria-label="hint"
        v-tooltip.left="hint"
        @click.stop="toggle"
    >
        <Icon :name="loading ? `spinner` : mine ? `stop` : `volume-up`" :spin="loading" class="text-2xs" />
    </button>
</template>
