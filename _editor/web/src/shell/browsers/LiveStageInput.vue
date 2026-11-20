<script setup lang="ts">
import { Button } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { StageInput } from "../../features/browsers/stageInput";
import type { BrowserView } from "../../features/browsers/useBrowserView";
import type { BrowserCommand } from "../../models/browsers/keyIntent";

// What the live browser's stage draws for input (stageInput.ts): the keyboard's hidden field, trackpad mode's cursor,
// and on a phone or tablet the buttons for its on-screen keyboard and trackpad mode.
defineProps<{
    readonly input: StageInput;
    readonly view: BrowserView;
    readonly interactive: boolean;
    readonly onCommand: (command: BrowserCommand) => void;
}>();
</script>

<template>
    <!-- Typing, an IME's candidates, dictation, a paste and a phone's keyboard all land here and go to the page (inputSink.ts); a phone's keyboard opens only when asked for. -->
    <!-- allow(inputs): never seen, a field only so the person's browser has somewhere to type; the design system's fields are for what a reader sees -->
    <textarea
        :ref="input.bindSink"
        data-zooms-own-page
        tabindex="-1"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        :inputmode="input.touchSeen.value && !input.softKeyboard.value ? 'none' : undefined"
        :aria-label="t(`browsers.browserView.keyboardField`)"
        class="pointer-events-none absolute z-0 h-px w-px resize-none overflow-hidden opacity-0"
        :style="input.sinkAt.value"
        @keydown="view.onKeyDown($event, onCommand)"
        @beforeinput="view.onBeforeInput"
        @input="view.onInput"
        @compositionend="view.onCompositionEnd"
        @paste="view.onPaste"
    />
    <!-- Trackpad mode's cursor: the picture carries no pointer, so a finger moving one needs to see it. -->
    <div
        v-if="input.trackpadDot.value"
        class="pointer-events-none absolute z-[2] h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-black/60 shadow"
        :style="input.trackpadDot.value"
    />
    <div v-if="input.touchSeen.value && interactive" class="absolute bottom-3 right-3 z-[2] flex gap-2">
        <Button
            size="small"
            :tier="input.softKeyboard.value ? 'accent' : 'boring'"
            :aria-pressed="input.softKeyboard.value"
            @click="input.toggleKeyboard"
        >
            {{ t(`browsers.browserView.keyboard`) }}
        </Button>
        <Button
            size="small"
            :tier="view.trackpad.value ? 'accent' : 'boring'"
            :aria-pressed="view.trackpad.value"
            @click="view.setTrackpad(!view.trackpad.value)"
        >
            {{ t(`browsers.browserView.trackpad`) }}
        </Button>
    </div>
</template>
