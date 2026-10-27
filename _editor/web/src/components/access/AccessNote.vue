<!-- The one line over a place the person can read but not change: what they can still do and who changes it, with the
     ask beside it. Quiet, not a notice: being read-only here is how this place is for them, not something that broke. -->
<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import type { AccessReason } from "../../client/sandbox/access/accessReason";
import AccessAsk from "./AccessAsk.vue";
import { accessWords } from "../../client/sandbox/access/accessWords";

const { reason, place } = defineProps<{
    reason: AccessReason;
    /** The place, as its page or section is titled ("Extensions"), for the owner reading the request. */
    place: string;
}>();

const words = computed(() => accessWords(reason, { place }));
</script>

<template>
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span class="inline-flex min-w-0 items-center gap-2"><Icon name="lock" aria-hidden="true" class="shrink-0" />{{ words.note }}</span>
        <AccessAsk :reason="reason" :place="place" small />
    </div>
</template>
