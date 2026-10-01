<script setup lang="ts">
import { type IconName, InlineRename, Row } from "@intentic/ui";
import UsageMeter from "../../../components/UsageMeter.vue";
import type { PlanHeadroom } from "../../chat/session/usageStatus";
import { useT } from "@intentic/ui/i18n";

// One row for every line the AI-account list shows (native account, subscription, the empty and add placeholders, the
// loading outline and the show-more toggle), all answering the same question: what am I signed in with, what can I do
// about it. Fixed anatomy, whichever provider or mechanism is behind it: a glyph in `Row`'s own `#lead` column (centred
// on the whole row, as every other list in the app puts one), the account's name, a dimmed note beside it, one status
// line under it, the actions, and an in-row sign-in panel below. `state` drives only the glyph and tone, never the layout.

const t = useT();

const {
    title = ``,
    state,
    activity,
    headroom,
    rename,
    interactive = false,
    pending = false,
} = defineProps<{
    title?: string;
    // `unknown` is the honest first frame: the daemon hasn't answered, so the dot must not claim either way. `blocked`
    // is connected but refused by somebody a reconnect cannot reach (an organisation's admin, a provider's own setup).
    // `action` is a row that does something rather than names a connection (add another, show more).
    state: `connected` | `reauth` | `blocked` | `missing` | `unknown` | `action`;
    // The action row's glyph; anything else draws its state.
    icon?: IconName;
    // The state line beside the title (who it signs in as, "not connected", "signing in...").
    note?: string;
    // Whether `note` is a live wait, which earns it a spinner: the one moving thing in the row.
    noteBusy?: boolean;
    // The half-sentence under the title: why it needs attention, or what it is waiting on.
    description?: string;
    // Nothing read yet: placeholder bars in the name's and the status line's places, so the real rows land without a shift.
    pending?: boolean;
    tone?: `default` | `warning`;
    interactive?: boolean;
    // Where a new name goes. Passing nothing is what makes a row unrenamable: only the sandbox's own credentials
    // have a name to change.
    rename?: (label: string) => Promise<void>;
    // Plan-limit headroom once read; replaces the dot with a meter. Undefined keeps the plain dot.
    headroom?: PlanHeadroom;
    // Spend on this connection, shown in the meter's card, not the row; omitted with no meter.
    activity?: string;
    // Whether this account is waiting to reopen (spent, or benched until an instant). Dims the name so active accounts
    // stand out; the status line stays legible, since it is what says why the row is dimmed.
    exhausted?: boolean;
}>();

const DOT_TONE: Record<string, string> = {
    connected: `bg-success`,
    reauth: `bg-warning`,
    blocked: `bg-danger`,
    missing: `bg-content/25`,
    unknown: `bg-content/25`,
};
</script>

<template>
    <!-- Every connection row stands at one height, two lines or one, so a list of them reads as a column rather than a staircase. -->
    <Row
        :interactive="interactive"
        :class="[tone === `warning` ? `bg-warning/10` : ``, state === `action` ? `` : `flex min-h-[calc(3.5rem+1px)] flex-col justify-center`]"
    >
        <!-- One column as wide as the tier's mark, so a dot, a meter and a plus all centre on the same line and every name starts at the same x. -->
        <template #lead="{ mark }">
            <span
                class="flex shrink-0 items-center justify-center"
                :class="[state === `action` ? `text-muted` : ``, exhausted ? `opacity-50` : ``]"
                :style="{ width: `${mark}px` }"
            >
                <Icon v-if="icon !== undefined" :name="icon" class="text-2xs" />
                <UsageMeter v-else-if="headroom && !pending" :headroom="headroom" :activity="activity" flank="left" />
                <span v-else class="h-1.5 w-1.5 rounded-full" :class="DOT_TONE[state]" />
            </span>
        </template>
        <template #title>
            <!-- One headline height and text origin across providers, whether the name is editable or plain. -->
            <span class="flex h-5 min-w-0 items-center gap-x-2.5" :class="[state === `action` ? `text-muted` : ``, exhausted ? `opacity-50` : ``]">
                <span v-if="pending" class="flex min-h-[1lh] items-center px-1" aria-hidden="true"><span class="skeleton block h-3 w-40" /></span>
                <!-- The name is the field: the row's own rename, in the same box the title sits in. -->
                <InlineRename
                    v-else-if="rename"
                    :value="title"
                    :write="rename"
                    :label="t(`sandbox.words.accountName`)"
                    :action="t(`ui.action.rename`)"
                    :maxlength="60"
                    failure="Couldn't rename that account."
                    class="min-w-0"
                />
                <!-- Matches the rename field's padding and transparent border. -->
                <span v-else class="min-w-0 truncate border border-transparent px-1" v-tooltip.overflow="title">{{ title }}</span>
                <span v-if="note" class="flex min-w-0 items-center gap-1 text-2xs font-normal text-subtle">
                    <Icon v-if="noteBusy" name="spinner" spin /><span class="truncate" v-tooltip.overflow="note">{{ note }}</span>
                </span>
            </span>
        </template>
        <!-- Starts where the name's text does (past the rename box's border and padding), so the two lines read as one block. -->
        <template v-if="description || pending" #description>
            <span v-if="pending" class="flex min-h-[1lh] items-center px-[calc(0.25rem+1px)]" aria-hidden="true">
                <span class="skeleton block h-2.5 w-56" />
            </span>
            <span
                v-else
                class="block min-h-[1lh] truncate px-[calc(0.25rem+1px)]"
                :class="tone === `warning` ? `text-warning` : exhausted ? `text-subtle` : ``"
                v-tooltip.overflow="description"
                >{{ description }}</span
            >
        </template>
        <template v-if="$slots[`control`]" #control><slot name="control" /></template>
        <template v-if="$slots[`below`]" #below><slot name="below" /></template>
    </Row>
</template>
