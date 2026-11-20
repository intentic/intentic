<!-- The chords a browser cannot send, or that this computer would keep for itself outside full screen, as a menu. -->
<script setup lang="ts">
import { AnchoredOverlay, Icon, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { type RemoteKey, SEND_KEYS, type SendKeysChord } from "./remoteKeys";

const { disabled = false } = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ send: [chord: readonly RemoteKey[]] }>();
const t = useT();

const open = ref(false);
const trigger = ref<HTMLElement>();

const items = computed<readonly { readonly chord: SendKeysChord; readonly label: string; readonly keys: string }[]>(() => [
    { chord: `ctrlAltDel`, label: t(`sandbox.deviceScreen.keysCtrlAltDel`), keys: `Ctrl+Alt+Del` },
    { chord: `win`, label: t(`sandbox.deviceScreen.keysWin`), keys: `Win` },
    { chord: `altTab`, label: t(`sandbox.deviceScreen.keysAltTab`), keys: `Alt+Tab` },
    { chord: `taskManager`, label: t(`sandbox.deviceScreen.keysTaskManager`), keys: `Ctrl+Shift+Esc` },
    { chord: `printScreen`, label: t(`sandbox.deviceScreen.keysPrintScreen`), keys: `PrtSc` },
]);

const send = (chord: SendKeysChord): void => {
    open.value = false;
    emit(`send`, SEND_KEYS[chord]);
};
</script>

<template>
    <button
        ref="trigger"
        type="button"
        :class="ui.chip({ on: open }, `shrink-0 font-medium`, !open && `text-content`)"
        :disabled="disabled"
        aria-haspopup="menu"
        :aria-expanded="open"
        @click="open = !open"
    >
        {{ t(`sandbox.deviceScreen.sendKeys`) }}
        <Icon name="chevron-down" class="text-3xs" aria-hidden="true" />
    </button>
    <AnchoredOverlay v-model="open" :anchor="trigger" side="bottom" cross="end">
        <div class="flex w-56 flex-col gap-0.5 p-1" role="menu">
            <button
                v-for="item in items"
                :key="item.chord"
                type="button"
                role="menuitem"
                class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-content transition-colors hover:bg-content/5"
                @click="send(item.chord)"
            >
                <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
                <kbd class="shrink-0 font-mono text-2xs text-muted">{{ item.keys }}</kbd>
            </button>
        </div>
    </AnchoredOverlay>
</template>
