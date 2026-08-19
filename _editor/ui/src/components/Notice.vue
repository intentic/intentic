<!-- SOMETHING WENT WRONG, SAID ONCE, THE SAME WAY EVERYWHERE. The shape and the reasoning are in notice.ts;
     this is the box that draws one. Every view that used to hand-roll `ui.alertDanger()` around an
     interpolated error string renders this instead, which is what makes the app's failures sound like one
     product rather than like sixty throw sites.

     TWO WAYS IN, ONE BOX. `:of` is the DATA case — a caught failure turned into a sentence, which is what the
     stack ranks and de-duplicates. The default slot is the AUTHORED case: a paragraph the view wrote, with a
     `<code>` or a `<b>` in it, which no model made of plain strings can carry.

     The second one had to exist because it already did, unofficially. Thirty-two views were still drawing
     `ui.alertDanger()`/`alertWarning()`/`alertInfo()` by hand — the same tinted box this component is built
     out of — for exactly one reason: their message was markup, not a string, and the model had nowhere to put
     it. So the app shipped two red boxes that differ only in whether they carry the warning icon, and which one
     a reader got was decided by whether the sentence happened to contain a link. That is not a distinction
     anybody can learn. The tint recipes are internal to notice.ts now; this is the box.

     Both entry points can be used together: `:of` writes the sentence, the slot adds what the sentence cannot
     say. -->
<script setup lang="ts">
import { twMerge } from "tailwind-merge";
import { computed, useAttrs } from "vue";
import Icon from "./Icon.vue";
import { type NoticeModel, NOTICE_BOX, NOTICE_ICON, type NoticeTone } from "./notice.js";
import type { IconName } from "../icons/iconSets.js";
import { ui } from "../lib/ui.js";

const { of, tone, dismissLabel = `` } = defineProps<{
    /** The data case: a failure the app turned into a sentence. */
    of?: NoticeModel;
    /** The authored case, for slot content — ignored when `of` is given, which carries its own tone. */
    tone?: NoticeTone;
    /* The tone picks the glyph, and that is right for a failure: three tones, three shapes, learned once. Pass
     * one only when the glyph carries information the tone does not — a setup that has not reported in yet is a
     * warning wearing a CLOCK, because what the reader needs to know is that time is the thing that has passed,
     * not that something is wrong. */
    icon?: IconName;
    dismissLabel?: string;
}>();
const emit = defineEmits<{ dismiss: [] }>();

const shown = computed<NoticeTone>(() => of?.tone ?? tone ?? `info`);

/* The caller's own classes go through twMerge rather than being appended, because the ones they pass are
 * overrides of what the box already sets — `px-4 py-3` against its `px-3 py-2`, `text-sm` against its `text-xs`.
 * Appended, those two land in one attribute and the winner is decided by where Tailwind happened to emit each
 * utility, not by which one the caller asked for. */
defineOptions({ inheritAttrs: false });
const attrs = useAttrs();
const boxClass = computed(() => twMerge(NOTICE_BOX[shown.value], attrs[`class`] as string | undefined));
</script>

<template>
    <!-- `alert` for the two tones a user has to act on, `status` for the one they don't: a polite region does
         not interrupt whatever a screen reader is already saying, which is the audible half of "calm". -->
    <div v-bind="{ ...attrs, class: undefined }" :class="boxClass" :role="shown === `info` ? `status` : `alert`">
        <Icon :name="icon ?? NOTICE_ICON[shown]" class="mt-px shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">
            <span v-if="of !== undefined" class="block">{{ of.title }}</span>
            <!-- The cause, one shade back. It is evidence, not the message — a reader who does not care about
                 it must be able to skip it by weight alone.

                 THE STEP BACK IS SIZE, NOT A FADE. At 70% opacity over the tone's own tinted panel this line
                 measured 3.2:1 on `info` and never cleared 4.3:1 on any tone — under the 4.5:1 that text this
                 small needs, so the one line carrying the raw cause was the least legible thing in the box.
                 Dimming it at all only ever bought a few percent of apparent weight, and `text-2xs` against
                 the title's `text-xs` says "secondary" more clearly than the fade did. -->
            <!-- `break-words` because the detail is where the UNBROKEN strings live — a URL, a sha, a token —
                 and one of those is wider than this box on any narrow panel. Without it the line does not wrap
                 at all: it runs out of the tint and pushes the layout it sits in. -->
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
