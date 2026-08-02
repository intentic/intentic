<script setup lang="ts">
import { cmp } from "@intentic/ui";
import type { Pricing } from "@intentic-app/api-contract";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";

interface Benefit {
    readonly title: string;
    readonly description: string;
}

/* The app's single Upgrade dialog (mounted in App.vue): opened from the account menu or by any plan-gate hit
 * (an API PAYMENT_REQUIRED — see useApi.isPaymentRequired). Shows the live Pro price + benefits; the CTA hands
 * off to Stripe Checkout via upgradeToPro(), which redirects the whole page. This is distinct from the
 * sandbox-side i.have.stripe capability — here the platform is the thing being paid for, and the subscription
 * lands in the central account (CLAUDE.md). */

// Two-way bound from the shell's account menu.
const visible = defineModel<boolean>(`visible`, { default: false });

const { upgradeToPro } = useAuth();

const submitting = ref(false);
const error = ref<string | null>(null);

// The live "pro" price, read from Stripe when the dialog first opens. Best-effort: on failure the hero simply
// omits the price line — the CTA still works and Stripe Checkout shows the real figure anyway.
const pricing = ref<Pricing | null>(null);

// Keep in step with the API's PLAN_ENTITLEMENTS (entitlements.ts) — this list is its marketing copy.
const benefits: readonly Benefit[] = [
    { title: `Unlimited sandboxes`, description: `The free plan includes one sandbox — Pro removes the limit` },
    { title: `Sandbox sharing`, description: `Invite teammates by email to work in sandboxes you own` },
];

// Format in the browser's locale with the currency Stripe reports; trailingZeroDisplay drops the ".00" on whole
// amounts. ponytail: amount / 100 assumes a 2-decimal currency (USD/EUR); revisit for zero-decimal ones (JPY).
const priceLabel = computed(() =>
    pricing.value
        ? new Intl.NumberFormat(undefined, {
              style: `currency`,
              currency: pricing.value.currency,
              trailingZeroDisplay: `stripIfInteger`,
          }).format(pricing.value.amount / 100)
        : ``,
);

// Fetch once, lazily — only when the user actually opens the dialog (no Stripe call for those who never do).
watch(visible, async (open) => {
    if (!open || pricing.value) {
        return;
    }
    try {
        pricing.value = await apiClient.billing.pricing();
    } catch {
        pricing.value = null;
    }
});

const upgrade = async (): Promise<void> => {
    if (submitting.value) {
        return;
    }
    submitting.value = true;
    error.value = null;
    try {
        // Redirects the whole page to Stripe Checkout on success, so there is nothing to close here.
        await upgradeToPro();
    } catch (err) {
        error.value = errorMessage(err, `Could not start checkout. Please try again.`);
    } finally {
        submitting.value = false;
    }
};

const reset = (): void => {
    error.value = null;
};
</script>

<template>
    <Dialog v-model:visible="visible" :modal="true" :draggable="false" :dismissable-mask="true" :style="{ width: '32rem' }" @hide="reset">
        <template #header>
            <span
                class="inline-flex items-center gap-1.5 rounded-full bg-primary-600/15 px-2 py-0.5 text-2xs font-semibold uppercase tracking-wide text-link"
            >
                <Icon name="star-fill" class="text-2xs" />
                Pro
            </span>
        </template>

        <div v-if="error" :class="cmp.alertDanger('mb-4')">{{ error }}</div>

        <!-- Price hero -->
        <div class="rounded-xl border border-line bg-linear-to-br from-primary-600/15 via-card to-card p-6 text-center">
            <p class="text-sm font-medium text-muted">Upgrade to Pro</p>
            <div v-if="priceLabel" class="mt-2 flex items-baseline justify-center gap-1">
                <span class="text-4xl font-semibold tracking-tight text-content">{{ priceLabel }}</span>
                <span class="text-sm text-muted">/ {{ pricing?.interval }}</span>
            </div>
            <p class="mt-2 text-sm text-muted">Everything you need to scale your AI workspace.</p>
        </div>

        <!-- Benefits -->
        <ul class="mt-5 flex flex-col gap-4">
            <li v-for="benefit in benefits" :key="benefit.title" class="flex items-start gap-3">
                <span class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-overlay text-link">
                    <Icon name="check" class="text-sm" />
                </span>
                <div class="min-w-0">
                    <p class="text-sm font-medium text-content">{{ benefit.title }}</p>
                    <p class="mt-0.5 text-xs text-muted">{{ benefit.description }}</p>
                </div>
            </li>
        </ul>

        <!-- CTA -->
        <Button label="Upgrade to Pro" class="mt-6 w-full justify-center" :loading="submitting" :disabled="submitting" @click="upgrade">
            <template #icon><Icon name="arrow-circle-up" /></template>
        </Button>
        <p class="mt-3 text-center text-2xs text-subtle">Cancel anytime · secure checkout via Stripe</p>
    </Dialog>
</template>
