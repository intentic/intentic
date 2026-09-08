<!--
    One box for every app failure, shaped and ranked by notice.ts. `:of` takes a caught failure turned into a sentence; the default slot takes
    authored prose, for markup a plain string can't carry. Both can be used together.
-->
<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, useAttrs } from "vue";
import Icon from "../primitives/Icon.vue";
import { type NoticeModel, NOTICE_BOX, NOTICE_ICON, type NoticeTone } from "./notice.js";
import type { IconName } from "../../icons/iconSets.js";
import { ui } from "../../lib/ui.js";

const { of, tone, dismissLabel = `` } = defineProps<{
    /** The data case: a failure the app already turned into a sentence. */
    of?: NoticeModel;
    /** The authored case for slot content; ignored when `of` is given, which carries its own tone. */
    tone?: NoticeTone;
    // Tone already picks the glyph; pass one only when it carries information the tone alone doesn't.
    icon?: IconName;
    dismissLabel?: string;
}>();
const emit = defineEmits<{ dismiss: [] }>();

const shown = computed<NoticeTone>(() => of?.tone ?? tone ?? `info`);

// twMerge, not append: caller classes override the box's own; append lets emit order pick the winner instead.
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const boxClass = computed(() => twMerge(NOTICE_BOX[shown.value], attrs[`class`] as string | undefined));
</script>

<template>
    <!-- `alert` for tones the user must act on, `status` for the one they don't (won't interrupt a screen reader). -->
    <div v-bind="{ ...attrs, class: undefined }" :class="boxClass" :role="shown === `info` ? `status` : `alert`">
        <Icon :name="icon ?? NOTICE_ICON[shown]" class="mt-px shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">
            <span v-if="of !== undefined" class="block">{{ of.title }}</span>
            <!--
                The cause, a shade back: evidence a reader may skip; sized down, not faded, since fading failed
                contrast.
            -->
            <!--
                `break-words`: the raw cause is often a URL/sha/token wider than the box; else the line pushes the
                layout.
            -->
            <span v-if="of?.detail !== undefined && of.detail !== ``" class="mt-0.5 block break-words text-2xs">{{ of.detail }}</span>
            <slot />
        </span>
        <button v-if="of?.action !== undefined" type="button" :class="ui.linkButton(`shrink-0 font-medium`)" @click="of.action.run()">
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
