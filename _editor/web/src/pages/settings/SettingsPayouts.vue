<script setup lang="ts">
import type { ClaimChallenge, CreatorState } from "@intentic-app/api-contract";
import { Card, type NoticeModel, Notice, Row } from "@intentic/ui";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import Button from "primevue/button";
import InputText from "primevue/inputtext";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../../composables/useApi";

/* Getting paid: the creator's side of the same pool the membership card buys into. Two things happen here and
 * nothing else — proving a publisher name is yours, and connecting somewhere the money can land. Both are
 * deliberately thin surfaces over work done elsewhere: the proof is a file in a repository the registry already
 * lists, and the payout details are collected by Stripe on its own pages, so this card never asks for a bank
 * account, a document or a tax form.
 *
 * The order on screen is the order of the work: what you already hold, then how to claim more, then where the
 * money goes. A creator arriving with nothing sees the claim step first, which is the only thing they can
 * usefully do. */

const state = ref<CreatorState | null>(null);
const loadError = ref<NoticeModel | undefined>(undefined);

const publisher = ref(``);
const challenge = ref<ClaimChallenge | null>(null);
const copied = ref(false);

/* THREE ACTIONS, THREE BUSY FLAGS. One shared flag made every button on the card spin whenever any of them
 * was pressed — checking a publisher name lit up "Set up payouts" too — which reads as "the whole card is
 * doing something" when only one thing is. Each failure likewise belongs beside the button that caused it,
 * not in a single slot at the foot of the card where a payout problem appears under the claim step. */
const { busy: checking, notice: checkNotice, run: runCheck } = useAsyncAction();
const { busy: verifying, notice: verifyNotice, run: runVerify } = useAsyncAction();

// Stripe returns the browser here after its hosted onboarding. `done` is informational — the status read below
// refreshes through to Stripe while an account is unfinished, so the answer on screen is already the fresh one.
const route = useRoute();
const justReturned = computed(() => route.query[`payouts`] === `done`);

const load = async (): Promise<void> => {
    try {
        state.value = await apiClient.creator.status();
    } catch (err) {
        loadError.value = noticeFrom(err, `Couldn't load your creator status.`);
    }
};

onMounted(load);

const payouts = computed(() => state.value?.payouts);

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const monthName = (month: string): string =>
    new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { year: `numeric`, month: `long`, timeZone: `UTC` });
const day = (stamp: string): string => new Date(stamp).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });

/* Closed months only, newest first — and a total, because a creator holding several names wants the answer to
 * "what am I owed" without adding up rows themselves. */
const statements = computed(() => state.value?.statements ?? []);
const owedTotal = computed(() => statements.value.reduce((sum, statement) => sum + statement.amountCents, 0));

// Receipts. A payment still in flight is shown rather than hidden: the run never abandons one, it keeps
// retrying the same payment, and a creator watching for money deserves to see that it is on its way.
const payments = computed(() => state.value?.payments ?? []);

// One sentence for where the payout setup stands, because "connected" alone is the one word that could mislead:
// an account can be finished and still not payable, and a creator needs to know which of those they are in.
const payoutLine = computed(() => {
    const current = payouts.value;
    if (current === undefined || !current.connected) {
        return `Not set up yet — nothing can be paid out until this is connected.`;
    }
    if (current.payoutsEnabled) {
        return `Connected and ready. Earnings are paid to this account.`;
    }
    if (current.detailsSubmitted) {
        return `Stripe has your details and is still reviewing them.`;
    }
    return `Started but not finished — Stripe still needs a few answers.`;
});

const askChallenge = async (): Promise<void> => {
    const name = publisher.value.trim().toLowerCase();
    if (name === ``) {
        return;
    }
    await runCheck(async () => {
        copied.value = false;
        // A fresh look-up retires whatever the last verify attempt said — that answer was about a name and a
        // push that are no longer the ones on screen.
        verifyNotice.value = undefined;
        challenge.value = await apiClient.creator.challenge({ publisher: name });
    }, `Couldn't look that publisher up.`);
};

const copyToken = async (): Promise<void> => {
    const token = challenge.value?.token;
    if (token === undefined) {
        return;
    }
    await navigator.clipboard?.writeText(token).catch(() => undefined);
    copied.value = true;
};

const finishClaim = async (): Promise<void> => {
    const name = challenge.value?.publisher;
    if (name === undefined) {
        return;
    }
    // The common failure is "the file isn't readable yet" — a push that hasn't landed, or the wrong branch.
    // The platform's own message says which, and rides along under this sentence rather than replacing it.
    await runVerify(async () => {
        await apiClient.creator.claim({ publisher: name });
        challenge.value = null;
        publisher.value = ``;
        await load();
    }, `That claim couldn't be verified yet.`);
};

/* Connecting is hand-rolled rather than another useAsyncAction for one reason: on success the browser leaves
 * for Stripe, and the button must stay busy until it does. A flag cleared the moment the URL comes back would
 * flick the button to idle while the page is still navigating, which reads as "nothing happened" at exactly
 * the moment something did. */
const connecting = ref(false);
const connectNotice = ref<NoticeModel | undefined>(undefined);

const connect = async (): Promise<void> => {
    if (connecting.value) {
        return;
    }
    connecting.value = true;
    connectNotice.value = undefined;
    try {
        const { url } = await apiClient.creator.connectPayouts();
        window.location.href = url;
    } catch (err) {
        connectNotice.value = noticeFrom(err, `Couldn't open the payout setup page.`);
        connecting.value = false;
    }
};
</script>

<template>
    <Card>
        <Row flush :heading="2" icon="credit-card" title="Getting paid" description="Claim what you publish, and connect where the money goes." />

        <div class="mt-3 flex flex-col gap-4">
            <Notice v-if="loadError" :of="loadError" />
            <p v-else-if="state && !state.enabled" class="text-xs text-muted">This platform doesn't run a creator pool.</p>

            <template v-else-if="state">
                <!-- What you already hold. Absent for most first visits, which is why it renders nothing at all
                     rather than an empty-state box competing with the step that matters. -->
                <div v-if="state.claims.length > 0" class="flex flex-col gap-1.5">
                    <h3 class="text-xs font-semibold">Your publisher names</h3>
                    <p v-for="claim in state.claims" :key="claim.publisher" class="text-xs text-muted">
                        <span class="font-medium text-content">{{ claim.publisher }}</span> — proved with
                        <span class="font-mono">{{ claim.repo }}</span>
                    </p>
                </div>

                <!-- Earnings, once a month is closed. Absent until then rather than shown as zero: a creator
                     whose first month is still running has earned an amount nobody can state yet. -->
                <div v-if="statements.length > 0" class="flex flex-col gap-1.5">
                    <h3 class="text-xs font-semibold">Earnings</h3>
                    <p class="text-sm">
                        {{ money(owedTotal) }} across {{ statements.length }} closed {{ statements.length === 1 ? `month` : `months` }}.
                    </p>
                    <p v-for="statement in statements" :key="`${statement.month}-${statement.publisher}`" class="text-xs text-muted">
                        <span class="font-medium text-content">{{ monthName(statement.month) }}</span> — {{ money(statement.amountCents) }} for
                        <span class="font-mono">{{ statement.publisher }}</span
                        >, payable {{ day(statement.payableAt) }}
                    </p>
                    <p v-if="!payouts?.payoutsEnabled" class="text-2xs text-muted">
                        Nothing can be sent until payouts are connected below. Earnings stay yours for twelve months from the month they were earned.
                    </p>
                </div>

                <!-- Receipts. -->
                <div v-if="payments.length > 0" class="flex flex-col gap-1.5">
                    <h3 class="text-xs font-semibold">Payments</h3>
                    <p v-for="payment in payments" :key="`${payment.createdAt}-${payment.amountCents}`" class="text-xs text-muted">
                        <template v-if="payment.status === `paid`">
                            <span class="font-medium text-content">{{ money(payment.amountCents) }}</span> paid
                            <template v-if="payment.paidAt">{{ day(payment.paidAt) }}</template>
                            <span v-if="payment.reference" class="font-mono text-2xs"> · {{ payment.reference }}</span>
                        </template>
                        <template v-else>
                            <span class="font-medium text-content">{{ money(payment.amountCents) }}</span> on its way — started
                            {{ day(payment.createdAt) }}. If it doesn't land, it's retried until it does.
                        </template>
                    </p>
                </div>

                <!-- The claim step. -->
                <div class="flex flex-col gap-2">
                    <h3 class="text-xs font-semibold">Claim a publisher name</h3>
                    <p class="text-xs text-muted">
                        Earnings add up against the publisher name in your manifest. Prove it's yours and they become payable to you.
                    </p>
                    <div class="flex gap-2">
                        <InputText v-model="publisher" placeholder="your publisher name" size="small" class="flex-1" @keyup.enter="askChallenge" />
                        <Button label="Check" severity="secondary" size="small" :loading="checking" @click="askChallenge" />
                    </div>
                    <Notice v-if="checkNotice" :of="checkNotice" />

                    <template v-if="challenge">
                        <p v-if="challenge.claimedByYou" class="text-xs text-muted">You already hold this name.</p>
                        <p v-else-if="challenge.claimedByOther" class="text-xs text-muted">
                            Another account already holds this name. If that's wrong, get in touch — a name is settled by who proved it first.
                        </p>
                        <p v-else-if="challenge.repos.length === 0" class="text-xs text-muted">
                            The registry lists no GitHub-backed extension under this name, so there's nothing to prove ownership against yet.
                        </p>
                        <template v-else>
                            <p class="text-xs text-muted">
                                Commit a file called <span class="font-mono">{{ challenge.path }}</span> containing this token to the default branch
                                of <span class="font-mono">{{ challenge.repos.join(`, `) }}</span> — any one of them is enough.
                            </p>
                            <div class="flex items-center gap-2">
                                <code class="flex-1 truncate rounded bg-overlay/50 px-2 py-1 text-2xs">{{ challenge.token }}</code>
                                <Button :label="copied ? `Copied` : `Copy`" severity="secondary" size="small" @click="copyToken" />
                            </div>
                            <div>
                                <Button label="I've pushed it — verify" size="small" :loading="verifying" @click="finishClaim" />
                            </div>
                            <Notice v-if="verifyNotice" :of="verifyNotice" />
                        </template>
                    </template>
                </div>

                <!-- Where the money goes. -->
                <div class="flex flex-col gap-2 border-t border-line pt-3">
                    <h3 class="text-xs font-semibold">Payout account</h3>
                    <p v-if="justReturned && !payouts?.payoutsEnabled" class="text-xs text-muted">
                        Thanks — Stripe is still finishing up. This page updates itself as soon as it's done.
                    </p>
                    <p class="text-xs text-muted">{{ payoutLine }}</p>
                    <p v-if="payouts?.disabledReason" class="text-xs text-muted">Stripe is holding payouts for: {{ payouts.disabledReason }}.</p>
                    <p class="text-2xs text-muted">
                        Bank details, identity and tax forms are collected by Stripe on its own pages — this platform never sees or stores them.
                    </p>
                    <div>
                        <Button
                            :label="payouts?.connected ? `Continue on Stripe` : `Set up payouts`"
                            severity="secondary"
                            size="small"
                            :loading="connecting"
                            @click="connect"
                        />
                    </div>
                    <Notice v-if="connectNotice" :of="connectNotice" />
                </div>
            </template>
        </div>
    </Card>
</template>
