<script setup lang="ts">
import type { MembershipState } from "@intentic-app/api-contract";
import { Card, Icon } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { errorMessage } from "../../composables/useAsyncAction";
import { apiClient } from "../../composables/useApi";
import { environment } from "../../environments/environment";

/* Membership: the one paid thing on the platform, bought and managed on Stripe's pages — this card only
 * states where things stand and opens the right door. The economics are said out loud on purpose (the price,
 * the creators' share, the public ledger link): the pool's promise is transparency, and the buying surface is
 * where it is cheapest to keep. */

const membership = ref<MembershipState | null>(null);
const loadError = ref<string | undefined>(undefined);
const working = ref(false);
const actionError = ref<string | undefined>(undefined);

// Stripe sends the browser back with ?membership=welcome after a completed checkout. The webhook that makes
// it real can land seconds later, so a fresh read here may still say "not a member" — the note covers the gap.
const route = useRoute();
const justJoined = computed(() => route.query[`membership`] === `welcome`);

onMounted(async () => {
    try {
        membership.value = await apiClient.pool.membership();
    } catch (err) {
        loadError.value = errorMessage(err, `Couldn't load the membership state.`);
    }
});

const renewsOn = computed(() => {
    const stamp = membership.value?.renewsAt;
    return stamp === undefined ? undefined : new Date(stamp).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });
});

const sharePercent = computed(() => Math.round((membership.value?.creatorShare ?? 0) * 100));

// The daily credit meter for metered service runs — present exactly when the caller is a member. Reset is
// UTC midnight; rendered as the reader's local time so "resets at" is a clock they own.
const creditsLine = computed(() => {
    const credits = membership.value?.credits;
    if (credits === undefined) {
        return undefined;
    }
    const resets = new Date(credits.resetsAt).toLocaleTimeString(undefined, { hour: `numeric`, minute: `2-digit` });
    return `${credits.remaining} of ${credits.allowance} service credits left today — resets at ${resets}.`;
});

// The public ledger, served by the platform for anyone — members are exactly who should read it.
const transparencyUrl = `${environment.api.url}/pool/transparency`;

const open = async (door: `checkout` | `portal`): Promise<void> => {
    if (working.value) {
        return;
    }
    working.value = true;
    actionError.value = undefined;
    try {
        const { url } = await (door === `checkout` ? apiClient.pool.checkout() : apiClient.pool.portal());
        window.location.href = url;
    } catch (err) {
        actionError.value = errorMessage(err, `Couldn't open the payment page.`);
        working.value = false;
    }
};
</script>

<template>
    <Card>
        <div class="flex items-center gap-2.5">
            <Icon name="star" class="text-lg text-muted" />
            <div>
                <h2 class="font-semibold leading-tight">Membership</h2>
                <p class="text-xs text-muted">Premium extensions, funding the people who build them.</p>
            </div>
        </div>
        <div class="mt-3 flex flex-col gap-2">
            <p v-if="loadError" class="text-2xs text-danger">{{ loadError }}</p>
            <p v-else-if="membership && !membership.enabled" class="text-xs text-muted">This platform doesn't offer memberships.</p>
            <template v-else-if="membership && membership.member">
                <p class="text-sm">
                    You're a member<template v-if="renewsOn"> — renews on {{ renewsOn }}</template
                    >.
                </p>
                <p v-if="creditsLine" class="text-xs text-muted">{{ creditsLine }}</p>
                <p v-if="membership.status && membership.status !== `active`" class="text-xs text-muted">
                    Stripe reports this membership as “{{ membership.status }}” — manage it below if something needs attention.
                </p>
                <p class="text-xs text-muted">
                    {{ sharePercent }}% of every credit you spend — installing premium extensions, running services — goes to their creators, on a
                    <a :href="transparencyUrl" target="_blank" rel="noopener" class="underline">public ledger</a>.
                </p>
                <div class="mt-1">
                    <Button label="Manage on Stripe" severity="secondary" :outlined="true" size="small" :loading="working" @click="open(`portal`)" />
                </div>
            </template>
            <template v-else-if="membership">
                <p v-if="justJoined" class="text-sm">
                    Payment received — your membership activates as soon as Stripe confirms it (usually seconds). Reload to see it.
                </p>
                <p class="text-sm">
                    <!-- The share is of every credit SPENT, not of the membership: credits nobody spends pay nobody. -->
                    ${{ membership.priceUsd }}/month unlocks premium extensions everywhere you work — and {{ sharePercent }}% of every credit you then
                    spend goes to the creators of what you install and run, on a
                    <a :href="transparencyUrl" target="_blank" rel="noopener" class="underline">public ledger</a>.
                </p>
                <div class="mt-1">
                    <Button :label="`Join for $${membership.priceUsd}/month`" size="small" :loading="working" @click="open(`checkout`)" />
                </div>
            </template>
            <p v-if="actionError" class="text-2xs text-danger">{{ actionError }}</p>
        </div>
    </Card>
</template>
