<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { agentStatusMeta, attentionReason, limitClosed, limitCountdown } from "../../fleet/agentStatus";
import type { TrayGroup } from "../view/childFold";

// CHILDREN STOPPED ON ONE THING, as one row of their parent's tray (childFold.trayOf): how many, what stopped them, and
// for a spent allowance when it reopens. Their parent was told how each of them ended and is still supervising them,
// so the row reports and asks nothing; it unfolds into their own rows, in the rows' glyph column, as the finished fold
// does, so a fold of any kind reads as one more row.

const props = defineProps<{
    group: TrayGroup;
    // The card the tray hangs from, named in the row's hover: whose news these are.
    parent: string;
}>();
const emit = defineEmits<{ toggle: [] }>();

const t = useT();

const count = computed(() => props.group.members.length);
const first = computed(() => props.group.members[0]);
const label = computed(() => {
    const key = props.group.key;
    const lead = first.value;
    if (key.startsWith(`limit:`) && lead !== undefined) {
        return t(`agents.childRows.limitGroup`, { count: count.value, provider: providerLabel(lead.provider) });
    }
    switch (key) {
        case `error`:
            return t(`agents.childRows.failedGroup`, { count: count.value });
        case `stopping`:
        case `stopped`:
            return t(`agents.childRows.stoppedGroup`, { count: count.value });
        case `interrupted`:
            return t(`agents.childRows.interruptedGroup`, { count: count.value });
        case `question`:
            return t(`agents.childRows.questionGroup`, { count: count.value });
        case `conflict`:
            return t(`agents.childRows.conflictGroup`, { count: count.value });
        default:
            return t(`agents.childRows.otherGroup`, {
                count: count.value,
                reason: lead === undefined ? key : (attentionReason(lead) ?? agentStatusMeta(lead.status).label),
            });
    }
});
// Ticks only while some member's window is still shut; the soonest reopening is the next moment anything can move.
const now = useNow(() => props.group.members.some((member) => limitClosed(member)));
const back = computed(() => {
    const shut = props.group.members.filter((member) => limitClosed(member, now.value));
    const soonest = shut.reduce<(typeof shut)[number] | undefined>(
        (best, member) => (best === undefined || (member.limitResetsAt ?? Infinity) < (best.limitResetsAt ?? Infinity) ? member : best),
        undefined,
    );
    return soonest === undefined ? undefined : limitCountdown(soonest, now.value);
});
</script>

<template>
    <button
        type="button"
        class="ui-row-select flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-2xs text-subtle max-md:min-h-10"
        :aria-expanded="group.open"
        v-tooltip.top="{
            title: t(`agents.childRows.parentNotified`),
            rows: [{ label: t(`agents.childRows.parent`), value: parent }],
            note: t(`agents.childRows.yoursIfStops`),
        }"
        @click="emit(`toggle`)"
    >
        <Icon :name="group.open ? `chevron-down` : `chevron-right`" class="shrink-0 text-xs" />
        <span class="min-w-0 flex-1 truncate">{{ label }}</span>
        <span v-if="back !== undefined" class="inline-flex shrink-0 items-center gap-1 tabular-nums">
            <Icon name="clock" class="shrink-0 text-2xs" />{{ t(`agents.agentCard.back`, { limitBackAt: back }) }}
        </span>
    </button>
</template>
