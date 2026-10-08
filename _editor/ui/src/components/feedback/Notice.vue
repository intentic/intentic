<!-- One box for every app failure, shaped and ranked by notice.ts. -->
<script setup lang="ts">
import { computed, useAttrs } from "vue";
import Icon from "../primitives/Icon.vue";
import { type NoticeModel, noticeLook, NOTICE_ICON, type NoticeSize, type NoticeTone } from "./notice.js";
import type { IconName } from "../../icons/iconSets.js";
import { ui } from "../../lib/ui.js";

const {
    of,
    tone,
    size = `md`,
    strip = false,
    dismissLabel = ``,
} = defineProps<{
    /** The data case: a failure the app already turned into a sentence. */
    of?: NoticeModel;
    /** The authored case for slot content; ignored when `of` is given, which carries its own tone. */
    tone?: NoticeTone;
    // Tone already picks the glyph; pass one only when it carries information the tone alone doesn't.
    icon?: IconName;
    size?: NoticeSize;
    /** Laid along a pane's top edge rather than standing in it: full width, square, a rule only underneath. */
    strip?: boolean;
    dismissLabel?: string;
}>();
const emit = defineEmits<{ dismiss: [] }>();

const shown = computed<NoticeTone>(() => of?.tone ?? tone ?? `info`);

// twMerge, not append: caller classes override the box's own; append lets emit order pick the winner instead.
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
// `#actions`: the view's own buttons after the sentence, wrapping under it in a narrow column.
const slots = defineSlots<{ default?: () => unknown; actions?: () => unknown }>();
// Read at render, not cached: neither attrs nor slots are reactive, and a conditional `#actions` comes and goes.
const look = (): ReturnType<typeof noticeLook> => noticeLook(shown.value, size, slots.actions !== undefined, strip);
const boxClass = (): string => look().box(attrs[`class`] as string | undefined);
// `alert` for tones the user must act on, `status` for the one they don't (won't interrupt a screen reader); a caller's own wins.
const role = computed(() => (attrs[`role`] as string | undefined) ?? (shown.value === `info` ? `status` : `alert`));
</script>

<template>
    <div v-bind="{ ...attrs, class: undefined }" :class="boxClass()" :role="role">
        <Icon :name="icon ?? NOTICE_ICON[shown]" :class="look().icon" aria-hidden="true" />
        <!-- With actions beside it, a floor rather than `min-w-0`: the actions wrap under the sentence before it squeezes to a word a line. -->
        <span class="flex-1" :class="slots.actions ? `min-w-[14rem]` : `min-w-0`">
            <span v-if="of !== undefined" class="block">{{ of.title }}</span>
            <!-- The cause, a shade back: evidence a reader may skip; sized down, not faded, since fading failed contrast. -->
            <!-- `break-words`: the raw cause is often a URL/sha/token wider than the box; else the line pushes the layout. -->
            <!-- `whitespace-pre-line`: a machine's refusal quotes its output line by line, which run together reads as one sentence. -->
            <span v-if="of?.detail !== undefined && of.detail !== ``" class="mt-0.5 block whitespace-pre-line break-words text-2xs">{{ of.detail }}</span>
            <slot />
        </span>
        <span v-if="slots.actions" class="flex shrink-0 flex-wrap items-center gap-1"><slot name="actions" /></span>
        <button v-if="of?.action !== undefined" type="button" :class="ui.textButton(`shrink-0 font-medium`)" @click="of.action.run()">
            {{ of.action.label }}
        </button>
        <button
            v-if="dismissLabel !== ``"
            type="button"
            class="-my-0.5 shrink-0 cursor-pointer rounded p-0.5 opacity-60 hover:opacity-100"
            :aria-label="dismissLabel"
            @click="emit(`dismiss`)"
        >
            <Icon name="times" class="text-2xs" />
        </button>
    </div>
</template>
