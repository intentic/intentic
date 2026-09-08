<script setup lang="ts">
import { formatTokens, Icon, ProgressRing, useDevice } from "@intentic/ui";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { effectiveAccount } from "../accounts/providerAccounts";
import { formatReset, formatUtilization, planHeadroom, SPENT_PERCENT, usageStatusFor } from "../session/usageStatus";
import { usePaneView } from "./useChat-view";
import { sandboxAvailabilityVisual } from "../../sandbox/overview/availability";
import { useSandboxAvailability } from "../../sandbox/overview/useSandboxAvailability";
import { useWorkspaceTree } from "../../workspace/explorer/useWorkspaceTree";
import ChatToolCallsToggle from "../tools/ChatToolCallsToggle.vue";
import UsageRing from "../../../components/UsageRing.vue";

// The pane's status bar: readouts under the composer, the one part of the footer outside the scroller — about the
// pane (context fill, subscription headroom, what send is waiting for), not the message being written. The left
// slot is the composer's own words (a refusal, a shortcut hint); everything right of it is measured off this
// pane's conversation and account.

const { block, hint } = defineProps<{
    /** Why Send won't go, if it won't; owns the slot whenever set. */
    block?: string;
    /** What the composer would rather say when nothing is refusing. */
    hint: string;
}>();

const { contextUsage, provider, account, model } = usePaneView();
const { mobile, keyboardInset } = useDevice();

// The sandbox's state as a reader should see it, not raw `reachable`: the liveness stream reconnects for ordinary
// reasons every minute or two, so a fast retry reads as `stale` and stays looking live (availability.ts) instead
// of flashing "busy". Send still gates on raw `reachable`.
const { hasSnapshot } = useWorkspaceTree();
const availability = useSandboxAvailability(hasSnapshot);
const availabilityVisual = computed(() => sandboxAvailabilityVisual(availability.value));

// Per-conversation context-window fill: a ring that warns as the chat approaches auto-compaction.
const contextRing = computed(() => {
    const usage = contextUsage.value;
    if (usage === undefined || usage.contextWindow <= 0) {
        return undefined;
    }
    const pct = Math.min(100, Math.round((usage.tokens / usage.contextWindow) * 100));
    return {
        value: pct,
        label: `${pct}%`,
        warn: pct >= 80,
        tooltip: `Context · ${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} (${pct}%)`,
    };
});

// Subscription headroom for this conversation's account, from the shared usage map; a small ring once there's a
// reading, tinted as the binding pool fills, keyed by account. Tracks the pool that gates this conversation's
// model specifically (its card lists all of them).
const usageChip = computed(() => {
    // Resolved through effectiveAccount: an unpicked conversation runs on the daemon's first, keyed the same way.
    const modelRef = model.value === `` ? undefined : { id: model.value };
    const headroom = planHeadroom(usageStatusFor(provider.value, effectiveAccount(provider.value, account.value), modelRef), modelRef);
    // No binding pool means nothing measured or everything reset; stays hidden rather than pinning a false 0%.
    if (headroom?.binding === undefined) {
        return undefined;
    }
    // Once a pool is effectively spent, its reset joins the visible label instead of waiting behind a hover.
    const reset = headroom.percent >= SPENT_PERCENT && headroom.binding.resetsAt !== undefined ? ` · ${formatReset(headroom.binding.resetsAt)}` : ``;
    return { headroom, label: `${formatUtilization(headroom.percent, headroom.stale)}${reset}` };
});

</script>

<template>
    <!--
        Carries the mobile keyboard inset for the whole footer, so the bottom-stuck composer rides up with it; rendered
        only where the composer is.
    -->
    <div
        class="mx-auto flex w-full max-w-[51rem] items-center gap-2 px-3 pb-2 text-2xs text-subtle"
        :style="mobile && keyboardInset > 0 ? { paddingBottom: `${keyboardInset + 8}px` } : undefined"
    >
        <!--
            The refusal owns this slot whenever set, since a tooltip alone never reaches touch; it displaces the keyboard
            hint, which is meaningless on a virtual keyboard and not worth the width in a narrow panel.
        -->
        <span v-if="block !== undefined" class="flex min-w-0 items-center gap-1 text-warning">
            <Icon name="exclamation-circle" class="shrink-0 text-2xs" />
            <span class="truncate">{{ block }}</span>
        </span>
        <span v-else-if="!mobile" class="@max-md:hidden">{{ hint }}</span>
        <div class="ml-auto flex items-center gap-3">
            <!--
                Whether this transcript shows its tool calls (ChatToolCallsToggle, also drawn in the Subagents pane); joins the
                other readouts under the composer.
            -->
            <ChatToolCallsToggle />
            <span v-if="contextRing" class="inline-flex items-center gap-1" v-tooltip.top="contextRing.tooltip">
                <ProgressRing :value="contextRing.value" :class="contextRing.warn ? 'text-warning' : 'text-primary-500'" />
                <span class="@max-xs:hidden">{{ contextRing.label }}</span>
            </span>
            <!-- The chip answers "am I about to get rate-limited": hover opens the pool-by-pool card, a click goes to the cost. -->
            <RouterLink
                v-if="usageChip"
                to="/sandbox/usage"
                class="touch-target inline-flex cursor-pointer items-center transition-colors hover:text-content"
            >
                <UsageRing :headroom="usageChip.headroom"
                    ><span class="@max-xs:hidden">{{ usageChip.label }}</span></UsageRing
                >
            </RouterLink>
            <!--
                Every chip here names a page, so each is a link: hover shows the address, Ctrl/Cmd-click opens it without
                leaving the chat.
            -->
            <RouterLink to="/sandbox/agent" class="touch-target inline-flex items-center gap-1 transition-colors hover:text-content">
                <!--
                    One spelling and colour for sandbox state, shared with the rail chip and switcher (availability.ts); a short
                    retry keeps the healthy look.
                -->
                <span class="inline-block h-1.5 w-1.5 rounded-full" :class="availabilityVisual.dotClass"></span>
                {{ availabilityVisual.label }} · Manage
            </RouterLink>
        </div>
    </div>
</template>
