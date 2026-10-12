<script setup lang="ts">
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSpeechPlayer } from "./speechPlayer";

// Reads one reply aloud, whole: its code announced rather than spelled, its paths and links shortened (the sandbox's
// voice-text.ts). One press reads it, the next stops it; while its voice is still loading the press shows that it took.

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
    void player.say(props.text, { key: key.value, as: `read`, lang: navigator.language });
};
</script>

<template>
    <button
        type="button"
        :class="ui.iconButton({ size: `sm`, tone: `subtle` })"
        :aria-pressed="mine"
        :aria-label="hint"
        v-tooltip.top="hint"
        @click.stop="toggle"
    >
        <Icon :name="loading ? `spinner` : mine ? `volume-off` : `volume-up`" :spin="loading" class="text-2xs" />
    </button>
</template>
