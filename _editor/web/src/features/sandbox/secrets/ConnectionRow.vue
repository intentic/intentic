<script setup lang="ts">
import { InlineRename, Row } from "@intentic/ui";
import UsageRing from "../../../components/UsageRing.vue";
import type { PlanHeadroom } from "../../chat/session/usageStatus";
import { useT } from "@intentic/ui/i18n";

// One row for every credential the Agent tab shows (native account, subscription, empty and add placeholders),
// all answering the same question: what am I signed in with, what can I do about it. Fixed anatomy: glyph, editable
// name, state text, one action, an in-row sign-in panel below. `state` drives only the glyph and tone, never the
// layout.

const t = useT();

const {
    title,
    state,
    activity,
    headroom,
    rename,
    interactive = false,
} = defineProps<{
    title: string;
    // `unknown` is the honest first frame: the daemon hasn't answered, so the dot must not claim either way.
    state: `connected` | `reauth` | `missing` | `unknown` | `add`;
    // The state line beside the title (the signed-in identity, "not connected", "signing in...").
    note?: string;
    // Whether `note` is a live wait, which earns it a spinner: the one moving thing in the row.
    noteBusy?: boolean;
    // The half-sentence under the title: what this connection costs, what it runs, or why it needs reconnecting.
    description?: string;
    // Description not loaded yet; shows a placeholder bar so a later-arriving line doesn't shift rows below it.
    descriptionPending?: boolean;
    tone?: `default` | `warning`;
    interactive?: boolean;
    // Where a new name goes. Passing nothing is what makes a row unrenamable: only the sandbox's own credentials
    // have a name to change.
    rename?: (label: string) => Promise<void>;
    // Plan-limit headroom once read; replaces the dot with a ring. Undefined keeps the plain dot.
    headroom?: PlanHeadroom;
    // Spend on this connection, shown in the ring's card, not the row; omitted with no ring (Cursor, Grok).
    activity?: string;
    // Whether this account is exhausted (>=90% utilization). Dims the row so active accounts stand out.
    exhausted?: boolean;
}>();

const DOT_TONE: Record<string, string> = {
    connected: `bg-success`,
    reauth: `bg-warning`,
    missing: `bg-content/25`,
    // Pulsing: not a verdict, something is still being read.
    unknown: `bg-content/25`,
};
</script>

<template>
    <Row :interactive="interactive" :class="[tone === `warning` ? `bg-warning/10` : ``, exhausted ? `opacity-50` : ``]">
        <template #title>
            <!-- Wraps, not truncates: the connection kind stays first so a Grok subscription row can't read as native. -->
            <span class="flex min-w-0 flex-wrap items-center gap-x-2.5" :class="state === `add` ? `text-muted` : ``">
                <span class="flex w-[1.125rem] shrink-0 justify-center">
                    <Icon v-if="state === `add`" name="plus" class="text-2xs" />
                    <!-- Ring replaces the dot when headroom is known, using the same green/yellow/red system. -->
                    <UsageRing v-else-if="headroom" :headroom="headroom" :activity="activity" flank="left" />
                    <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT_TONE[state]" />
                </span>
                <!-- The name is the field: the row's own rename, in the same box the title sits in. -->
                <InlineRename
                    v-if="rename"
                    :value="title"
                    :write="rename"
                    :label="t(`sandbox.connectionRow.accountName`)"
                    :action="t(`ui.action.rename`)"
                    :maxlength="60"
                    failure="Couldn't rename that account."
                    class="min-w-0"
                />
                <span v-else class="min-w-0 truncate" v-tooltip.overflow="title">{{ title }}</span>
                <span v-if="note" class="flex items-center gap-1 text-2xs font-normal text-subtle">
                    <Icon v-if="noteBusy" name="spinner" spin />{{ note }}
                </span>
            </span>
        </template>
        <!-- Indented to the title's x, not the glyph's. -->
        <template v-if="description || descriptionPending" #description>
            <span v-if="descriptionPending" class="flex min-h-[1lh] items-center pl-7" aria-hidden="true">
                <span class="skeleton block h-2.5 w-56" />
            </span>
            <span v-else class="block pl-7" :class="tone === `warning` ? `text-warning` : ``">{{ description }}</span>
        </template>
        <template v-if="$slots[`control`]" #control><slot name="control" /></template>
        <template v-if="$slots[`below`]" #below><slot name="below" /></template>
    </Row>
</template>
