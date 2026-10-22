<script setup lang="ts">
import { AppBrand, Button, Notice } from "@intentic/ui";
import { usePoll } from "@intentic/ui/async";
import { formatDate } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { FREE_TIER, HOSTED_TIERS, hostedTier, isHostedTierId } from "@intentic/constants";
import { computed, onMounted, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useAuth } from "../../../client/auth/useAuth";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { apiClient } from "../../../lib/useApi";
import { signInAt } from "../../../lib/routes/signIn";
import { hostedJourney } from "./hostedJourney";
import { useHostedStart } from "./useHostedStart";
import SetupAccount from "../SetupAccount.vue";

const t = useT();
const route = useRoute();
const router = useRouter();
const { user, linkGoogle } = useAuth();
const account = user.value?.id ?? ``;
const requestedTier = route.query[`tier`];
const journey = hostedJourney(account);
const creatingAnother = computed(() => route.query[`new`] === `1` || route.query[`plan`] === `welcome`);
const setupPath = (id: string, tier?: string) => ({ path: `/setup`, query: { sandbox: id, machine: `hosted`, tier } });
const start = useHostedStart(
    {
        platform: apiClient,
        sandbox: useSandbox(),
        journey,
        enter: async (id, tier) => {
            await router.push(setupPath(id, tier));
        },
        redirect: (url) => {
            window.location.assign(url);
        },
        exclusive: (work) => (navigator.locks === undefined ? work() : navigator.locks.request(`hosted-start/${account}`, work)),
    },
    isHostedTierId(requestedTier) ? requestedTier : FREE_TIER.id,
);
const { tier, rows, offer, plan, loaded, refreshing, busy, error, owned, shared, pending, block } = start;
const chosen = computed(() => ({ ...hostedTier(tier.value), ...(tier.value === FREE_TIER.id ? plan.value?.hosted?.freeTier[`shape`] : undefined) }));
const pendingTier = computed(() => journey.read()?.tier ?? tier.value);
const hoursReturn = computed(() => offer.value?.hours?.rampUntil ?? plan.value?.hosted?.freeHours.resetsAt);
const showCreate = computed(() => owned.value.length === 0 || creatingAnother.value);
const waitingForPayment = computed(
    () => route.query[`plan`] === `welcome` && loaded.value && tier.value !== FREE_TIER.id && offer.value?.remaining === 0,
);
const availableTiers = computed(() => HOSTED_TIERS.filter((rung) => rung.id === FREE_TIER.id || plan.value?.enabled));
const another = async (): Promise<void> => {
    journey.reset();
    await router.replace({ path: `/start/hosted`, query: { ...route.query, new: `1` } });
};
const chooseTier = async (event: Event): Promise<void> => {
    if (!(event.target instanceof HTMLSelectElement)) {
        return;
    }
    const value = event.target.value;
    if (!isHostedTierId(value)) {
        return;
    }
    await router.replace({ path: `/start/hosted`, query: { ...route.query, tier: value } });
};
const switchAccount = (): void => {
    window.location.assign(router.resolve(signInAt(route.fullPath)).href);
};
const link = async (): Promise<void> => {
    busy.value = true;
    try {
        await linkGoogle(route.fullPath);
    } catch (failure) {
        error.value = failure instanceof Error ? failure.message : t(`hostedStart.loadFailed`);
    } finally {
        busy.value = false;
    }
};
onMounted(start.load);
watch(
    () => route.query[`tier`],
    (next) => {
        void start.chooseTier(isHostedTierId(next) ? next : FREE_TIER.id);
    },
);
watch(offer, (next) => {
    if (route.query[`plan`] === `welcome` && (next?.remaining ?? 0) > 0) {
        void router.replace({ path: `/start/hosted`, query: { ...route.query, plan: undefined, new: `1` } });
    }
});
usePoll({
    everyMs: 3_000,
    check: async () => {
        if (waitingForPayment.value && !busy.value) {
            await start.load();
        }
    },
    immediate: false,
}).start();
</script>

<template>
    <div class="entry min-h-dvh overflow-auto px-5 py-8 sm:px-8 sm:py-12">
        <main class="mx-auto flex w-full max-w-2xl flex-col gap-6" data-hosted-start>
            <header class="flex flex-wrap items-center justify-between gap-4">
                <AppBrand />
                <SetupAccount :before-sign-out="async () => undefined" :after-sign-out="switchAccount" show-email-on-mobile />
            </header>
            <div>
                <p class="entry-eyebrow">{{ t(`hostedStart.location`) }}</p>
                <h1 class="mt-3 text-3xl leading-tight font-semibold sm:text-4xl">{{ t(`hostedStart.title`) }}</h1>
                <p class="mt-3 text-muted">{{ t(`hostedStart.intro`) }}</p>
            </div>
            <Notice v-if="error" role="alert" tone="danger">{{ error }}</Notice>
            <div v-if="!loaded" role="status" class="flex flex-col items-start gap-3">
                <p v-if="!error">{{ t(`hostedStart.loading`) }}</p>
                <Button v-else :label="t(`hostedStart.retry`)" @click="start.load" />
            </div>
            <template v-else>
                <section v-if="owned.length" class="entry-frame flex flex-col gap-4 p-5 sm:p-6" :aria-label="t(`hostedStart.existing`)">
                    <h2 class="text-lg font-semibold">{{ t(`hostedStart.existing`) }}</h2>
                    <div v-for="box in owned" :key="box.id" class="flex flex-wrap items-center justify-between gap-3">
                        <div class="min-w-0">
                            <p class="truncate font-medium">{{ box.name }}</p>
                            <p class="text-sm text-muted">{{ t(`hostedStart.location`) }}</p>
                        </div>
                        <Button
                            :as="RouterLink"
                            :to="setupPath(box.id)"
                            :label="
                                box.lastSeenAt === null
                                    ? t(`hostedStart.continue`)
                                    : box.hosted?.state === `asleep`
                                      ? t(`hostedStart.wake`)
                                      : t(`hostedStart.open`)
                            "
                        />
                    </div>
                    <Button v-if="!creatingAnother" :label="t(`hostedStart.another`)" tier="boring" @click="another" />
                </section>
                <section v-if="pending && pending.hosted === null" class="entry-frame flex flex-col gap-3 p-5">
                    <p>{{ t(`hostedStart.unfinished`) }}</p>
                    <Button :as="RouterLink" :to="setupPath(pending.id, pendingTier)" :label="t(`hostedStart.continue`)" />
                </section>
                <section v-if="showCreate" class="entry-frame flex flex-col gap-4 p-5 sm:p-6" :aria-busy="busy">
                    <label for="hosted-tier" class="font-medium">{{ t(`hostedStart.machine`) }}</label>
                    <select
                        id="hosted-tier"
                        :value="tier"
                        :disabled="busy || refreshing || waitingForPayment"
                        class="min-h-11 w-full rounded-lg border border-line bg-canvas p-3"
                        @change="chooseTier"
                    >
                        <option v-for="rung in availableTiers" :key="rung.id" :value="rung.id">
                            {{ rung.name }} · {{ t(`hostedStart.price`, { price: rung.priceUsd }) }}
                        </option>
                    </select>
                    <p class="text-sm text-muted">
                        {{ t(`hostedStart.specs`, { cpus: chosen.cpus, memory: chosen.memoryMb / 1024, disk: chosen.volumeGb }) }}
                    </p>
                    <p v-if="offer?.hours" class="text-sm">
                        {{ t(`hostedStart.hours`, { remaining: offer.hours.remaining, allowance: offer.hours.allowance }) }}
                    </p>
                    <p v-if="tier === FREE_TIER.id" class="text-sm text-muted">{{ t(`hostedStart.freeNote`) }}</p>
                    <p v-else class="text-sm text-muted">{{ t(`hostedStart.paidNote`, { price: chosen.priceUsd }) }}</p>
                    <p v-if="offer?.unopenedDays" class="text-sm text-muted">{{ t(`hostedStart.retention`, { days: offer.unopenedDays }) }}</p>
                    <p v-if="waitingForPayment" role="status">{{ t(`hostedStart.paymentWaiting`) }}</p>
                    <p v-else-if="block" role="status">{{ t(`hostedStart.block.${block}`) }}</p>
                    <p v-if="block === `hours` && hoursReturn" class="text-sm">
                        {{ t(`hostedStart.hoursReturn`, { date: formatDate(new Date(hoursReturn).getTime()) }) }}
                    </p>
                    <Button
                        v-if="block === undefined"
                        :label="tier === FREE_TIER.id ? t(`hostedStart.createFree`) : t(`hostedStart.createPaid`)"
                        :loading="busy"
                        :disabled="refreshing"
                        @click="start.create"
                    />
                    <Button v-else-if="block === `google`" :label="t(`hostedStart.linkGoogle`)" :loading="busy" @click="link" />
                    <Button
                        v-else-if="tier !== FREE_TIER.id && block === `occupied` && plan?.enabled && !waitingForPayment"
                        :label="t(`hostedStart.buy`, { price: chosen.priceUsd })"
                        :loading="busy"
                        @click="start.purchase"
                    />
                    <Button v-else :label="t(`hostedStart.retry`)" tier="boring" :disabled="busy" @click="start.load" />
                    <p class="text-sm text-muted">{{ t(`hostedStart.aiAccounts`) }}</p>
                </section>
                <section v-if="shared.length" class="flex flex-col gap-3">
                    <h2 class="font-medium">{{ t(`hostedStart.shared`) }}</h2>
                    <RouterLink v-for="box in shared" :key="box.id" :to="{ path: `/`, query: { sandbox: box.id } }" class="text-link">{{
                        box.name
                    }}</RouterLink>
                </section>
                <RouterLink to="/setup?machine=mine" class="self-start text-sm text-link">{{ t(`hostedStart.ownComputer`) }}</RouterLink>
                <RouterLink v-if="rows.some((row) => row.lastSeenAt !== null)" to="/" class="self-start text-sm text-link">{{
                    t(`setup.setup.backToWorkspace`)
                }}</RouterLink>
            </template>
        </main>
    </div>
</template>
