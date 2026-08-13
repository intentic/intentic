<!-- SOMETHING WENT WRONG, SAID ONCE, THE SAME WAY EVERYWHERE. The shape and the reasoning are in notice.ts;
     this is the box that draws one. Every view that used to hand-roll `cmp.alertDanger()` around an
     interpolated error string renders this instead, which is what makes the app's failures sound like one
     product rather than like sixty throw sites. -->
<script setup lang="ts">
import Icon from "./Icon.vue";
import { type NoticeModel, NOTICE_BOX, NOTICE_ICON } from "./notice.js";
import { cmp } from "../cmp";

const { of, dismissLabel = `` } = defineProps<{ of: NoticeModel; dismissLabel?: string }>();
const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
    <!-- `alert` for the two tones a user has to act on, `status` for the one they don't: a polite region does
         not interrupt whatever a screen reader is already saying, which is the audible half of "calm". -->
    <div :class="NOTICE_BOX[of.tone]" :role="of.tone === `info` ? `status` : `alert`">
        <Icon :name="NOTICE_ICON[of.tone]" class="mt-px shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">
            <span class="block">{{ of.title }}</span>
            <!-- The cause, one shade back. It is evidence, not the message — a reader who does not care about
                 it must be able to skip it by weight alone.

                 THE STEP BACK IS SIZE, NOT A FADE. At 70% opacity over the tone's own tinted panel this line
                 measured 3.2:1 on `info` and never cleared 4.3:1 on any tone — under the 4.5:1 that text this
                 small needs, so the one line carrying the raw cause was the least legible thing in the box.
                 Dimming it at all only ever bought a few percent of apparent weight, and `text-2xs` against
                 the title's `text-xs` says "secondary" more clearly than the fade did. -->
            <span v-if="of.detail !== undefined && of.detail !== ``" class="mt-0.5 block text-2xs">{{ of.detail }}</span>
        </span>
        <button v-if="of.action !== undefined" type="button" :class="cmp.linkButton(`shrink-0 font-medium`)" @click="of.action.run()">
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
