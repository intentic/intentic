<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { creditSummary, formatCredits, resetsAtLocal } from "../composables/membership/creditMeter";
import { useMembership } from "../composables/membership/useMembership";

/* TODAY'S CREDITS, WHERE THE ACCOUNT LIVES — the rail's avatar menu and the phone's Account section, which are
 * the same menu in two form factors and so share this row rather than two copies of it.
 *
 * WHY HERE AND NOT ON A DASHBOARD. The allowance belongs to the signed-in PERSON, not to the sandbox they happen
 * to have open: one meter is spent by every sandbox they own. This menu is the only always-reachable surface in
 * the product that is scoped to the person — it already holds their email and the door to their settings — so it
 * is the one place a balance can sit without being either buried in a settings tab (where it was, and where
 * nobody found it) or pinned to a sandbox it does not belong to.
 *
 * IT STAYS QUIET, ON PURPOSE. The membership page promises that nothing in this product is metered, and it means
 * it: no usage counting exists anywhere. A permanent counter bolted to the app frame would read as a retraction
 * of that promise even though it counts nothing — so the number lives one click inside a menu, and the only
 * thing that reaches the frame itself is a dot on the avatar when the allowance is actually gone (see
 * AccountPanel). "You can't overspend" is a reassurance that needs somewhere to be checked, not advertised.
 *
 * A ROW THAT NAVIGATES, because the questions this raises — what the allowance is for, what a credit pays, when
 * it renews — are all answered on the membership page and none of them fit here. */

const { meter, member } = useMembership();

const resets = computed(() => resetsAtLocal(meter.value));
const summary = computed(() => creditSummary(meter.value));
</script>

<template>
    <!-- Nothing for a non-member, and nothing on a platform that sells no membership: neither has an allowance,
         and an empty meter would claim they had one and had spent it. The menu is simply as it was. -->
    <RouterLink
        v-if="member && meter"
        :to="{ name: `settings`, params: { tab: `membership` } }"
        class="flex flex-col gap-1.5 rounded-md px-2 py-1.5 transition-colors hover:bg-content/5"
        :aria-label="summary"
    >
        <div class="flex items-baseline gap-1.5">
            <Icon name="star" class="shrink-0 self-center text-2xs text-muted" />
            <!-- The remainder is the headline because it is the answer to the only question this row is opened
                 with. The allowance rides beside it in the quieter voice: it is the context, not the news. -->
            <span class="text-xs font-medium tabular-nums text-content">{{ formatCredits(meter.remaining) }}</span>
            <span class="min-w-0 truncate text-2xs text-muted">of {{ formatCredits(meter.allowance) }} credits left today</span>
        </div>

        <!-- The bar measures what is LEFT, unlike every other meter in this app — a wallet emptying rather than a
             rate limit filling. It carries no colour meaning of its own for the same reason the membership card's
             does not: a low meter is a day's work done, not a fault. -->
        <div class="h-1 overflow-hidden rounded-full bg-content/10">
            <div class="h-full rounded-full bg-primary-fill transition-[width]" :style="{ width: `${meter.remainingPercent}%` }" />
        </div>

        <!-- Spent is the one state that needs a sentence rather than a figure: a zero on its own reads as a
             problem, and what is actually true is that the whole allowance comes back tonight owing nothing. -->
        <span v-if="meter.spent" class="text-2xs text-muted">Spent for today — the full allowance is back at {{ resets }}.</span>
        <span v-else-if="meter.low" class="text-2xs text-muted">Not enough for another premium install today.</span>
        <span v-else class="text-2xs text-subtle">Resets at {{ resets }}</span>
    </RouterLink>
</template>
