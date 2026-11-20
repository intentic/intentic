<!-- A window's sound, where castd carries it: on until muted, remembered per window (mediaSound.ts). -->
<script setup lang="ts">
import { Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { MediaSound } from "../../models/browsers/media/sound/mediaSound";

const props = defineProps<{ sound: MediaSound }>();
const t = useT();
const label = computed(() => (props.sound.muted.value ? t(`browsers.media.unmute`) : t(`browsers.media.mute`)));
</script>

<template>
    <button
        type="button"
        :class="ui.iconButton({ size: `md`, round: true })"
        :aria-pressed="sound.muted.value"
        :aria-label="label"
        v-tooltip.bottom="label"
        @click="sound.toggleMute()"
    >
        <Icon :name="sound.muted.value ? `volume-off` : `volume-up`" class="text-xs" />
    </button>
</template>
