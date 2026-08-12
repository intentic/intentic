<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { affordable, formatCredits, remainingAfter, resetsAtLocal } from "../../composables/membership/creditMeter";
import { useMembership } from "../../composables/membership/useMembership";

/* WHAT A PREMIUM INSTALL COSTS, SAID BEFORE THE BUTTON THAT SPENDS IT.
 *
 * This is the product's only irreversible one-click spend, and until now the listing said the word "Premium" and
 * nothing else: the price lived on the membership page, the balance lived on the membership page, and a reader
 * pressed Install with neither in front of them. They found out what it cost by going somewhere else afterwards
 * and noticing a number had moved. That is the gap this block closes — nothing about the money is new, only its
 * being visible at the moment it changes hands.
 *
 * THE BALANCE IS PART OF THE PRICE. "200 credits" alone is not an answer to "can I do this"; it becomes one next
 * to what is left and what would be left. So all three are stated together, and the arithmetic is done here
 * rather than left to the reader.
 *
 * IT NEVER DISABLES THE BUTTON — deliberately, and this is the subtle one. The donation is idempotent per
 * extension per month (pool.routes.ts), so somebody who already supported this extension this month installs it
 * again for FREE, and their balance is irrelevant. A browser cannot know which case it is in: this app is told
 * the price and the balance, never the donation history. Graying out Install on a short balance would therefore
 * block a free reinstall, so a shortfall is STATED as a possibility and the platform stays the thing that
 * decides — it refuses cleanly and refunds, which is exactly what it is for. "Might not go through" is the
 * honest sentence; "will fail" would be a claim this surface cannot support. */

const { update = false } = defineProps<{
    /** An update re-donates (at most once a month), so it is the same money with a different verb. */
    update?: boolean;
}>();

const { offered, member, meter, donationCredits } = useMembership();

const price = computed(() => donationCredits.value);
const covered = computed(() => affordable(meter.value, price.value));
const after = computed(() => remainingAfter(meter.value, price.value));
const resets = computed(() => resetsAtLocal(meter.value));

/* Nothing to say on a platform with no pool: a premium listing there cannot be installed at all, the listing's
 * own state line says so, and a price for something nobody can buy is noise. Nothing to say either where the
 * platform gives its extensions away — there is no charge to warn anybody about. */
const silent = computed(() => !offered.value || price.value <= 0);
</script>

<template>
    <!-- ══ NOT A MEMBER ════════════════════════════════════════════════════════════════════════════════════
         The gate, as an offer rather than a refusal. This reader cannot install this, and the useful thing to
         hand them is the door — not a disabled button and a word they have to go and look up. -->
    <div v-if="!silent && !member" class="flex items-start gap-2.5 rounded-lg border border-primary-fill/25 bg-primary-fill/[0.07] px-3 py-2.5">
        <Icon name="star" class="mt-0.5 shrink-0 text-sm text-link" />
        <div class="min-w-0 flex-1 text-xs">
            <p class="font-semibold text-content">This one is premium</p>
            <p class="mt-0.5 text-muted">
                Installing it pays its creator {{ formatCredits(price) }} credits from a membership's daily allowance. Using it afterwards is free
                forever.
            </p>
            <RouterLink :to="{ name: `settings`, params: { tab: `membership` } }" class="mt-1 inline-block font-medium text-link hover:underline">
                See what a membership costs →
            </RouterLink>
        </div>
    </div>

    <!-- ══ A MEMBER, WITH A METER ══════════════════════════════════════════════════════════════════════════
         The price as a figure on its own, because it is the fact being disclosed; the balance under it, because
         that is what turns a figure into a decision. -->
    <div v-else-if="!silent" class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span class="text-xs font-semibold text-content">{{ update ? `Updating supports the creator` : `Supports the creator` }}</span>
            <span class="shrink-0 text-sm font-semibold tabular-nums text-content">{{ formatCredits(price) }} credits</span>
        </div>

        <!-- What it leaves. Read as one line — "800 left today · 600 after this" — because the two numbers only
             mean something as a before and an after. -->
        <p v-if="meter" class="text-2xs" :class="covered ? `text-muted` : `text-warning`">
            <span class="tabular-nums">{{ formatCredits(meter.remaining) }}</span> left today
            <template v-if="covered">
                · <span class="tabular-nums">{{ formatCredits(after) }}</span> after this
            </template>
            <template v-else> — that might not cover this, in which case nothing is charged and the allowance comes back at {{ resets }}. </template>
        </p>

        <!-- The two things that stop this reading as a subscription: it is charged once a month per extension,
             and the extension itself never charges again. Both are the reason an install is worth saying yes to. -->
        <p class="text-2xs leading-relaxed text-subtle">
            Once a month per extension — {{ update ? `another update` : `a reinstall` }} this month is free, and using it always is.
        </p>
    </div>
</template>
