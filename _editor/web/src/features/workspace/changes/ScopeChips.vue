<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import HoverCard from "../../chat/tabs/HoverCard.vue";
import { originHue } from "./changeOrigins";
import { sameScope, type CommitScope } from "./commitScope";
import { useCommitScope } from "./useCommitScope";

// What Commit records, picked in one click: a chip per session with work here, your own edits, git's index, and
// everything (useCommitScope.ts). `compact` is the phone's row over the list, where a session's chip shows its name
// only once picked; the commit page has the room to name every one.

const { compact = false } = defineProps<{ compact?: boolean }>();

const t = useT();
const { scope, scopeChips, toggleScope, scopeLabel, originLabel, originProvider, originMark, originDrafting, originCard } = useCommitScope();

const on = (target: CommitScope): boolean => sameScope(target, scope.value);
const named = (target: CommitScope): boolean => target.kind !== `origin` || !compact || on(target);

const chipText = (target: CommitScope): string => {
    switch (target.kind) {
        case `origin`:
            return originLabel(target.id);
        case `yours`:
            return t(`workspace.reviewPanel.chipYou`);
        case `staged`:
            return t(`workspace.reviewPanel.chipStaged`);
        case `everything`:
            return t(`workspace.reviewPanel.chipAll`);
    }
};

// A session keeps its hue whether picked or not, so its chip and its rows' badges read as one colour; the picked one
// gets an edge, the rest step back. Git's own selections take the kit's plain chip and its lit state.
const chipClass = (target: CommitScope): string => {
    if (target.kind === `origin`) {
        return [originHue(target.id).chip, on(target) ? `border-current/40` : `opacity-60 hover:opacity-100`].join(` `);
    }
    return on(target) ? `ui-chip-on` : ``;
};

const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
const showCard = (event: MouseEvent, target: CommitScope): void => {
    if (target.kind === `origin`) {
        hoverCard.value?.show(event, originCard([target.id]));
    }
};
</script>

<template>
    <div
        v-if="scopeChips.length > 1"
        class="flex min-w-0 items-center gap-1"
        :class="compact ? `flex-nowrap` : `flex-wrap gap-y-1.5`"
        role="group"
        :aria-label="t(`workspace.reviewPanel.changeScope`, { scope: scopeLabel(scope) })"
        data-commit-scope
    >
        <span v-if="compact" class="mr-0.5 shrink-0 text-2xs uppercase tracking-wide text-subtle">{{ t(`workspace.reviewPanel.from`) }}</span>
        <template v-for="chip in scopeChips" :key="chip.key">
            <span v-if="chip.divided" class="mx-0.5 h-3.5 w-px shrink-0 bg-line" aria-hidden="true"></span>
            <button
                type="button"
                class="ui-chip gap-1"
                :class="[chipClass(chip.scope), named(chip.scope) && chip.scope.kind === `origin` ? `min-w-0 shrink` : `shrink-0`]"
                :aria-pressed="on(chip.scope)"
                :aria-label="
                    t(`workspace.reviewPanel.scopeChipLabel`, {
                        scope: scopeLabel(chip.scope),
                        files: t(`workspace.reviewPanel.fileCount`, { count: chip.files }, chip.files),
                    })
                "
                @click="toggleScope(chip.scope)"
                @mouseenter="showCard($event, chip.scope)"
                @mouseleave="hoverCard?.hide()"
                data-scope-chip
            >
                <template v-if="chip.scope.kind === `origin`">
                    <!-- A dot before the logo: the session hasn't finished, so its count is an instalment, not a total. -->
                    <span v-if="originMark(chip.scope.id)" class="h-1.5 w-1.5 shrink-0 rounded-full" :class="originMark(chip.scope.id)!.dot"></span>
                    <!-- The same slot, spent on a different wait: its commit message still being written. -->
                    <span
                        v-else-if="originDrafting(chip.scope.id)"
                        class="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-current opacity-60"
                    ></span>
                    <ProviderLogo v-if="originProvider(chip.scope.id)" :provider="originProvider(chip.scope.id)!" class="shrink-0 text-2xs" />
                    <Icon v-else name="sparkles" class="shrink-0 text-2xs" />
                </template>
                <span v-if="named(chip.scope)" class="min-w-0 truncate">{{ chipText(chip.scope) }}</span>
                <span class="shrink-0 tabular-nums opacity-70">{{ chip.files }}</span>
            </button>
        </template>
        <HoverCard ref="hoverCard" />
    </div>
</template>
