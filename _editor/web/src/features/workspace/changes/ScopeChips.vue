<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import HoverCard from "../../chat/tabs/HoverCard.vue";
import { originHue } from "./changeOrigins";
import { useChanges } from "./useChanges";
import { chipState, type ScopeChip, useCommitScope } from "./useCommitScope";

// Stage in one click: a chip per session with work here, your own edits, and all of it (useCommitScope.ts). A click
// stages the chip's files, the same move as a row's +, and a second takes them back out; several can be in at once,
// and the Staged section of the list is what Commit records. `compact` is the phone's row over the list, where a
// session's chip shows its name only once its files are in.

const { compact = false } = defineProps<{ compact?: boolean }>();

const t = useT();
const changes = useChanges();
const { scopeChips, toggleChip, chipLabel, originProvider, originMark, originDrafting, originCard } = useCommitScope();

const named = (chip: ScopeChip): boolean => chip.kind !== `origin` || !compact || chipState(chip) !== `off`;
const chipText = (chip: ScopeChip): string => {
    switch (chip.kind) {
        case `origin`:
            return chipLabel(chip);
        case `yours`:
            return t(`workspace.reviewPanel.chipYou`);
        case `all`:
            return t(`workspace.reviewPanel.chipAll`);
    }
};
// How much of it is in: the whole count, or "in/of" while only part of it is.
const countText = (chip: ScopeChip): string => (chipState(chip) === `mixed` ? `${chip.staged}/${chip.files}` : `${chip.files}`);

// A plain chip until its files are in. Then a session's chip takes its hue, so it reads as one colour with its rows'
// badges, and the rest take the kit's lit state; one partly in gets a dashed edge.
const chipClass = (chip: ScopeChip): string => {
    const state = chipState(chip);
    if (state === `off`) {
        return ``;
    }
    const lit = chip.kind === `origin` ? `${originHue(chip.id!).chip} border-current/50` : `ui-chip-on`;
    return state === `mixed` ? `${lit} border-dashed` : lit;
};
const chipTip = (chip: ScopeChip): string => {
    const values = { scope: chipLabel(chip), files: t(`workspace.reviewPanel.fileCount`, { count: chip.files }, chip.files) };
    return chipState(chip) === `on` ? t(`workspace.reviewPanel.unstageChip`, values) : t(`workspace.reviewPanel.stageChip`, values);
};

const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const showCard = (event: MouseEvent, chip: ScopeChip): void => {
    if (chip.kind === `origin`) {
        hoverCard.value?.show(event, { ...originCard([chip.id!]), note: chipTip(chip) });
    }
};
</script>

<template>
    <div
        v-if="scopeChips.length > 1"
        class="flex min-w-0 items-center gap-1"
        :class="compact ? `flex-nowrap` : `flex-wrap gap-y-1.5`"
        role="group"
        :aria-label="t(`workspace.reviewPanel.stageLabel`)"
        data-commit-scope
    >
        <span class="mr-0.5 shrink-0 text-2xs uppercase tracking-wide text-subtle">{{ t(`workspace.reviewPanel.stageLabel`) }}</span>
        <template v-for="chip in scopeChips" :key="chip.key">
            <span v-if="chip.divided" class="mx-0.5 h-3.5 w-px shrink-0 bg-line" aria-hidden="true"></span>
            <button
                type="button"
                class="ui-chip gap-1"
                :class="[chipClass(chip), named(chip) && chip.kind === `origin` ? `min-w-0 shrink` : `shrink-0`]"
                :aria-pressed="chipState(chip) === `mixed` ? `mixed` : chipState(chip) === `on`"
                :aria-label="chipTip(chip)"
                :disabled="changes.actionBusy.value"
                v-tooltip.top="chip.kind === `origin` ? undefined : chipTip(chip)"
                @click="toggleChip(chip)"
                @mouseenter="showCard($event, chip)"
                @mouseleave="hoverCard?.hide()"
                data-scope-chip
            >
                <template v-if="chip.kind === `origin`">
                    <!-- A dot before the logo: the session hasn't finished, so its count is an instalment, not a total. -->
                    <span v-if="originMark(chip.id!)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="originMark(chip.id!)!.dot"></span>
                    <!-- The same slot, spent on a different wait: its commit message still being written. -->
                    <span v-else-if="originDrafting(chip.id!)" class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-60"></span>
                    <ProviderLogo v-if="originProvider(chip.id!)" :provider="originProvider(chip.id!)!" class="shrink-0 text-2xs" />
                    <Icon v-else name="sparkles" class="shrink-0 text-2xs" />
                </template>
                <Icon v-else-if="chipState(chip) === `on`" name="check" class="shrink-0 text-3xs" />
                <span v-if="named(chip)" class="min-w-0 truncate">{{ chipText(chip) }}</span>
                <span class="shrink-0 tabular-nums opacity-70">{{ countText(chip) }}</span>
            </button>
        </template>
        <HoverCard ref="hoverCard" />
    </div>
</template>
