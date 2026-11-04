<!-- EVERY TIME THIS PRIVATE CONVERSATION WAS OPENED WITHOUT ASKING, at the top of its chat for good: who, when, why in their
     own words, and until when they may read. Nothing dismisses it, since the record is the promise (schemas/seal.ts
     SealOpenSchema): an opening waiting on a second person says so, and one a second person refused says who did. Toned
     as a warning, never as danger: it is a fact the reader is owed, not something broken. -->
<script setup lang="ts">
import type { SealOpen } from "@intentic/sandbox-contract/schemas/seal";
import { Button, formatDayMonthTime, toneFill } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";
import { ref } from "vue";
import { answerOpening } from "../../../../models/fleet/presses/sealPresses";
import { fullName, openingStanding } from "../../../../models/agent-status/sealView";

const t = useT();

const { conversationId, opens, canApprove = false } = defineProps<{
    conversationId: string;
    opens: readonly SealOpen[];
    /** The reader may be the second person a pending opening waits on. */
    canApprove?: boolean;
}>();

const busy = ref<string>();
const failure = ref<string>();
const answer = async (open: SealOpen, agree: boolean): Promise<void> => {
    busy.value = open.id;
    failure.value = undefined;
    try {
        await answerOpening(conversationId, open.id, agree);
    } catch (error) {
        failure.value = messageOr(error, t(`chat.seal.openings.answerFailed`));
    } finally {
        busy.value = undefined;
    }
};

// How long it reads for, said as a plan for a future instant and as a date once it has passed.
const untilLine = (open: SealOpen): string =>
    open.until > Date.now() ? t(`chat.seal.openings.readOnlyUntil`, { until: formatUntil(open.until) }) : t(`chat.seal.openings.readUntil`, { until: formatDayMonthTime(open.until) });
</script>

<template>
    <div class="flex flex-col gap-2" data-seal-openings>
        <div
            v-for="open in opens"
            :key="open.id"
            class="flex flex-col gap-1 rounded-xl px-3 py-2 text-xs"
            :class="toneFill(`warning`, `soft`)"
            role="note"
            :data-seal-opening="openingStanding(open)"
        >
            <p class="font-medium text-content">
                <template v-if="openingStanding(open) === `opened`">{{
                    t(`chat.seal.openings.opened`, { name: fullName(open), at: formatDayMonthTime(open.at) })
                }}</template>
                <template v-else-if="openingStanding(open) === `pending`">{{ t(`chat.seal.openings.pending`, { name: fullName(open) }) }}</template>
                <template v-else>{{ t(`chat.seal.openings.refused`, { name: fullName(open), by: fullName(open.refusedBy) }) }}</template>
            </p>
            <!-- The reason in the opener's own words, quoted, as the author was shown it. -->
            <q class="text-content">{{ open.reason }}</q>
            <p v-if="openingStanding(open) === `opened`" class="text-2xs text-muted">
                {{ untilLine(open) }}<template v-if="open.approvedBy !== undefined"> · {{ t(`chat.seal.openings.agreedBy`, { name: fullName(open.approvedBy) }) }}</template>
            </p>
            <div v-else-if="openingStanding(open) === `pending` && canApprove" class="flex flex-wrap items-center gap-1.5 pt-1">
                <Button size="small" tier="accent" :loading="busy === open.id" :disabled="busy !== undefined" @click="answer(open, true)">{{
                    t(`chat.seal.openings.approve`)
                }}</Button>
                <Button size="small" tier="boring" :disabled="busy !== undefined" @click="answer(open, false)">{{ t(`chat.seal.openings.refuse`) }}</Button>
            </div>
        </div>
        <p v-if="failure !== undefined" role="alert" class="px-1 text-2xs text-danger">{{ failure }}</p>
    </div>
</template>
