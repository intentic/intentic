<script setup lang="ts">
import type { CreatorState } from "@intentic-app/api-contract";
import {
    Button,
    type IconName,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    type RowTone,
    SkeletonRows,
    ui,
    useLoadingReveal,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { apiClient } from "../../composables/useApi";
import SettingsPublisherClaim from "./SettingsPublisherClaim.vue";

/* Getting paid: the creator's side of the same pool the membership card buys into. Two things happen here and
 * nothing else: proving a publisher name is yours, and connecting somewhere the money can land. Both are
 * deliberately thin surfaces over work done elsewhere: the proof is a file in a repository the registry already
 * lists, and the payout details are collected by Stripe on its own pages, so this tab never asks for a bank
 * account, a document or a tax form.
 *
 * LAID OUT AS GROUPED ROWS, like every other settings tab. It used to be one <Card> holding six `<h3
 * class="text-xs font-semibold">` headings over paragraphs of `text-xs text-muted`, which is a heading size the
 * app's scale does not contain and a body size one step under what Appearance, Notifications and Data set
 * theirs at. Sat next to those tabs in the same rail it read as a different product: smaller, denser, and with
 * no surface saying which sentence belonged to which section. Everything here is <RowGroup> + <Row> now, so a
 * publisher name, a statement and a payout account are the same kind of object on screen that a preference is
 * one tab over.
 *
 * THE TAB'S NAME IS NOT REPEATED AS A HEADING. The rail already says "Getting paid" and the hub's own header
 * says "Settings"; an h2 saying it a third time is the row of chrome the grouped-list layout exists to drop.
 *
 * The order on screen is the order of the work: what you have earned, the names that earn it, then where the
 * money goes. A creator arriving with nothing has no earnings block and no names block, so the claim step is
 * the first thing they meet, which is the only thing they can usefully do. */

const state = ref<CreatorState | null>(null);
const loadError = ref<NoticeModel | undefined>(undefined);

// Stripe returns the browser here after its hosted onboarding. `done` is informational. The status read below
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

/* Whether the wait has lasted long enough to be worth drawing. The subject is fixed because there is only ever
 * one: this tab reads the signed-in account's creator status and nothing switches underneath it. */
const outline = useLoadingReveal(
    computed(() => state.value === null && loadError.value === undefined),
    computed(() => `creator-status`),
);

const payouts = computed(() => state.value?.payouts);

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;
const monthName = (month: string): string =>
    new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { year: `numeric`, month: `long`, timeZone: `UTC` });
const day = (stamp: string): string => new Date(stamp).toLocaleDateString(undefined, { year: `numeric`, month: `long`, day: `numeric` });

/* Closed months only, newest first, and a total, because a creator holding several names wants the answer to
 * "what am I owed" without adding up rows themselves. */
const statements = computed(() => state.value?.statements ?? []);
const owedTotal = computed(() => statements.value.reduce((sum, statement) => sum + statement.amountCents, 0));

/* Receipts. A payment still in flight is shown rather than hidden: the run never abandons one, it keeps
 * retrying the same payment, and a creator watching for money deserves to see that it is on its way.
 *
 * The line is assembled here rather than out of nested <template v-if>s, which is where the missing space in
 * "Paid16 July 2026" came from: Vue condenses the whitespace either side of a template boundary, so a sentence
 * built across one has no reliable gap in it. */
const payments = computed(() => state.value?.payments ?? []);
type Payment = CreatorState[`payments`][number];
const paymentLine = (payment: Payment): string =>
    payment.status === `paid`
        ? `Paid${payment.paidAt === undefined ? `` : ` ${day(payment.paidAt)}`}`
        : `On its way since ${day(payment.createdAt)}. If it doesn't land, it's retried until it does.`;

/* WHERE THE PAYOUT SETUP STANDS, as a glyph, a name and a sentence at once. The sentence was always here and
 * always had to be, because "connected" alone is the one word that could mislead: an account can be finished
 * and still not payable. What it lacked was any way to tell at a glance which of the four it was in, so the
 * state now also picks the row's lead tone: green for payable, amber for anything Stripe is still holding,
 * plain for not started. The row says it in colour before its sentence is read, which is the rule every other
 * stateful row in the app follows. */
const payout = computed<{ icon: IconName; tone: RowTone; title: string; line: string }>(() => {
    const current = payouts.value;
    if (current === undefined || !current.connected) {
        return {
            icon: `credit-card`,
            tone: `default`,
            title: `Not set up`,
            line: `Nothing can be paid out until this is connected. Stripe collects the details on its own pages.`,
        };
    }
    if (current.payoutsEnabled) {
        return { icon: `check-circle`, tone: `success`, title: `Connected`, line: `Earnings are paid to this account.` };
    }
    if (current.detailsSubmitted) {
        return { icon: `clock`, tone: `warning`, title: `In review`, line: `Stripe has your details and is still reviewing them.` };
    }
    return { icon: `exclamation-circle`, tone: `warning`, title: `Unfinished`, line: `Started but not finished. Stripe still needs a few answers.` };
});

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
    <div class="flex flex-col gap-6">
        <Notice v-if="loadError" :of="loadError" />
        <p v-else-if="state && !state.enabled" :class="ui.emptyState()">This platform doesn't run a creator pool.</p>

        <template v-else-if="outline">
            <!-- THE WAIT IS DRAWN, NOT SKIPPED, and it is drawn as the GROUPS that are coming rather than as a
                 column of loose bars. The two below are the two that always land once the read does (the names
                 you hold and where they get paid); earnings and receipts are not promised here, because a
                 creator on their first visit has neither, and an outline showing blocks that never arrive is a
                 worse lie than the blank it replaced.

                 <SkeletonRows> rather than hand-cut bars: it renders REAL <Row>s, so the outline inherits this
                 page's padding and density by construction instead of drifting from it the next time a tier
                 changes. -->
            <div class="flex flex-col gap-6" role="status" aria-busy="true">
                <span class="sr-only">Reading your creator status…</span>
                <RowGroup density="compact">
                    <template #label><span class="skeleton block h-2.5 w-32" aria-hidden="true" /></template>
                    <SkeletonRows :rows="2" description />
                </RowGroup>
                <RowGroup>
                    <template #label><span class="skeleton block h-2.5 w-28" aria-hidden="true" /></template>
                    <SkeletonRows :rows="1" description control />
                </RowGroup>
            </div>
        </template>

        <template v-else-if="state">
            <!-- ══ EARNINGS ═══════════════════════════════════════════════════════════════════════════════
                 THE NUMBER IS A NUMBER, at the size the membership tab sets its own headline figure. It used
                 to be `text-sm` inside a sentence ("$40.00 across 2 closed months"), which is the one fact
                 this tab is opened for rendered smaller than the paragraph explaining it. The sentence is
                 still there; it is now the caption under the figure rather than the container for it.

                 Absent until a month closes rather than shown as zero: a creator whose first month is still
                 running has earned an amount nobody can state yet. -->
            <RowGroup v-if="statements.length > 0" density="compact" label="Earnings" :count="statements.length">
                <RowNote variant="block">
                    <div class="flex flex-col gap-1.5">
                        <div class="flex flex-wrap items-baseline gap-x-2">
                            <span class="text-3xl font-semibold leading-none tabular-nums text-content">{{ money(owedTotal) }}</span>
                            <span class="text-sm text-muted">
                                owed across {{ statements.length }} closed {{ statements.length === 1 ? `month` : `months` }}
                            </span>
                        </div>
                        <p v-if="!payouts?.payoutsEnabled" class="text-xs text-muted">
                            Nothing can be sent until a payout account is connected below. Earnings stay yours for twelve months from the month they
                            were earned.
                        </p>
                    </div>
                </RowNote>
                <Row v-for="statement in statements" :key="`${statement.month}-${statement.publisher}`">
                    <template #title>{{ monthName(statement.month) }}</template>
                    <template #description
                        ><span class="font-mono">{{ statement.publisher }}</span></template
                    >
                    <template #meta>
                        <span class="font-medium text-content">{{ money(statement.amountCents) }}</span>
                        <span>payable {{ day(statement.payableAt) }}</span>
                    </template>
                </Row>
            </RowGroup>

            <!-- ══ PUBLISHER NAMES ════════════════════════════════════════════════════════════════════════
                 Absent for most first visits, which is why it renders nothing at all rather than an empty-state
                 box competing with the claim step directly under it. -->
            <RowGroup v-if="state.claims.length > 0" density="compact" label="Publisher names" :count="state.claims.length">
                <Row v-for="claim in state.claims" :key="claim.publisher" icon="check-circle" tone="success" :title="claim.publisher">
                    <template #description
                        >proved with <span class="font-mono">{{ claim.repo }}</span></template
                    >
                </Row>
            </RowGroup>

            <!-- The claim step, which is a screen of its own (SettingsPublisherClaim) and brings its own group:
                 it reads the workspace's repositories and pushes to one, which is far more than this tab does. -->
            <SettingsPublisherClaim @claimed="load" />

            <!-- ══ PAYOUT ACCOUNT ═════════════════════════════════════════════════════════════════════════
                 THE ONE ACTION ON THIS TAB, so it wears the accent tier while there is something to set up and
                 drops to the neutral one once there isn't. It used to be `severity="secondary"` in both states,
                 which is the same silhouette a "Copy" chip wears: the single thing standing between a creator
                 and their money looked exactly as optional as everything beside it. -->
            <RowGroup label="Payout account">
                <Row :icon="payout.icon" :tone="payout.tone" :title="payout.title" :description="payout.line">
                    <template #control>
                        <Button
                            :label="payouts?.connected ? `Continue on Stripe` : `Set up payouts`"
                            :severity="payouts?.payoutsEnabled ? `secondary` : undefined"
                            size="small"
                            :loading="connecting"
                            @click="connect"
                        />
                    </template>
                    <template v-if="(justReturned && !payouts?.payoutsEnabled) || payouts?.disabledReason || connectNotice" #below>
                        <div class="flex flex-col gap-2">
                            <p v-if="justReturned && !payouts?.payoutsEnabled" class="text-xs text-muted">
                                Thanks. Stripe is still finishing up. This page updates itself as soon as it's done.
                            </p>
                            <p v-if="payouts?.disabledReason" class="text-xs text-muted">
                                Stripe is holding payouts for: {{ payouts.disabledReason }}.
                            </p>
                            <Notice v-if="connectNotice" :of="connectNotice" />
                        </div>
                    </template>
                </Row>
            </RowGroup>

            <!-- ══ RECEIPTS ═══════════════════════════════════════════════════════════════════════════════
                 Last, because it is the only block here that is purely history. The lead glyph tells a landed
                 payment from one still in flight without reading either line. -->
            <RowGroup v-if="payments.length > 0" density="compact" label="Payments" :count="payments.length">
                <Row
                    v-for="payment in payments"
                    :key="`${payment.createdAt}-${payment.amountCents}`"
                    :icon="payment.status === `paid` ? `check-circle` : `clock`"
                    :tone="payment.status === `paid` ? `success` : `default`"
                    :title="money(payment.amountCents)"
                    :description="paymentLine(payment)"
                >
                    <template v-if="payment.status === `paid` && payment.reference" #meta>
                        <span class="font-mono">{{ payment.reference }}</span>
                    </template>
                </Row>
            </RowGroup>
        </template>
    </div>
</template>
