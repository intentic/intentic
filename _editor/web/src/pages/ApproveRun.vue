<script setup lang="ts">
import type { ServiceOfferCard } from "@intentic-app/api-contract";
import { Button, Card, Icon, Notice, type NoticeModel, Row } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRoute } from "vue-router";
import { formatCredits as n } from "../composables/membership/creditMeter";
import { apiClient } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import AppBrand from "../components/AppBrand.vue";

/* THE APPROVAL CARD, AS A PAGE, and the reason a Claude Code session can be trusted with a spending catalogue
 * at all.
 *
 * Inside a sandbox this is a frame in the owner's own conversation and a click the daemon is holding a socket
 * open for. Outside one there is no conversation of ours and no socket: the agent gets told to open a URL, the
 * owner lands here, and the tool call is retried afterwards. So the click has to leave something behind, and
 * what it leaves behind is a row (api mcp/mcp-offer.ts) that the run re-reads before it charges anything.
 *
 * WHAT THAT BUYS, precisely: the agent's report that its user consented is never read anywhere. Claude Code
 * ships a hook that can auto-answer the dialog which sends somebody here; auto-answering it releases nothing,
 * because the grant only exists if this page wrote it. That is the difference between a gate and a prompt.
 *
 * EVERY NUMBER HERE IS THE PLATFORM'S. The price was stamped on the offer when it went up, so a listing
 * repriced while somebody is deciding cannot change what they agreed to, and nothing the calling agent typed
 * reaches this page except the request body and the one line of why, both of which are labelled as its words
 * rather than ours. */

const route = useRoute();
const { user, refresh, signInWithGoogle } = useAuth();

const id = String(route.params[`id`]);
const offer = ref<ServiceOfferCard>();
const resolving = ref(true);
const working = ref(false);
const settled = ref<`approved` | `declined` | `already_settled` | `expired`>();
const error = ref<NoticeModel>();

const load = async (): Promise<void> => {
    try {
        offer.value = await apiClient.pool.offer({ id });
    } catch (err) {
        // A cuid that is not this account's reads exactly like one that never existed, which is the correct
        // amount to say: the request body on an offer can carry anything the task was about.
        error.value = { tone: `danger`, title: `That approval isn't available.`, detail: errorMessage(err, ``) };
    }
};

onMounted(async () => {
    await refresh().catch(() => undefined);
    if (user.value !== null) {
        await load();
    }
    resolving.value = false;
});

const signIn = (): Promise<void> => signInWithGoogle(route.fullPath);

/* THE CLOCK, shown rather than implied. An offer stands for ten minutes; a person who walked away from their
 * terminal and came back deserves to know whether clicking will still do anything, before they click. */
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    tick = setInterval(() => {
        now.value = Date.now();
    }, 1_000);
});
onUnmounted(() => {
    if (tick !== undefined) {
        clearInterval(tick);
    }
});

const secondsLeft = computed(() => {
    if (offer.value === undefined) {
        return 0;
    }
    return Math.max(0, Math.floor((new Date(offer.value.expiresAt).getTime() - now.value) / 1000));
});

const countdown = computed(() => `${Math.floor(secondsLeft.value / 60)}:${String(secondsLeft.value % 60).padStart(2, `0`)}`);

// Pretty-printed, because the point of showing it is that somebody can read it. Falls back to the raw string
// for a body that is not JSON: better an ugly truth than a swallowed one.
const requestBody = computed(() => {
    const raw = offer.value?.request ?? ``;
    try {
        return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
        return raw;
    }
});

const affordable = computed(() => offer.value?.credits_remaining === undefined || offer.value.credits_remaining >= offer.value.credits);

const settle = async (approve: boolean): Promise<void> => {
    if (working.value) {
        return;
    }
    working.value = true;
    error.value = undefined;
    try {
        const { outcome } = await apiClient.pool.settleOffer({ id, approve });
        settled.value = outcome;
    } catch (err) {
        error.value = { tone: `danger`, title: `Couldn't record that.`, detail: errorMessage(err, ``) };
    } finally {
        working.value = false;
    }
};

/* Which screen. `settled` is this tab's own answer and wins over the loaded status, so the moment after a
 * click reads as what just happened rather than as a stale card. */
const view = computed(() => {
    if (resolving.value) {
        return `loading`;
    }
    if (user.value === null) {
        return `signin`;
    }
    if (offer.value === undefined) {
        return `missing`;
    }
    if (settled.value !== undefined) {
        return settled.value;
    }
    if (offer.value.status !== `pending`) {
        return offer.value.status;
    }
    return secondsLeft.value <= 0 ? `expired` : `pending`;
});
</script>

<template>
    <div class="flex min-h-screen w-full items-start justify-center bg-canvas p-6 text-content @container">
        <div class="mt-8 w-full max-w-xl">
            <AppBrand class="mb-8 text-2xl" />

            <div v-if="view === 'loading'" class="flex items-center gap-3 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>Loading the approval…</span>
            </div>

            <Card v-else-if="view === 'signin'">
                <Row
                    flush
                    :heading="2"
                    icon="lock"
                    title="Sign in to approve"
                    description="Your agent asked to run a paid service. Sign in to see what it wants to send and what it costs."
                />
                <Button label="Continue with Google" severity="secondary" class="mt-5 justify-center" @click="signIn">
                    <template #icon><Icon name="google" /></template>
                </Button>
            </Card>

            <Card v-else-if="view === 'missing'">
                <Row
                    flush
                    :heading="2"
                    icon="question-circle"
                    title="That approval isn't available"
                    description="It may have already been used, or it belongs to a different account. Nothing was charged."
                />
            </Card>

            <!-- ══ THE ASK ══════════════════════════════════════════════════════════════════════════════════
                 Price first, because it is the decision. Then what will be sent, then why: in that order,
                 because a reader who has decided on the price does not read further, and a reader who has not
                 wants the body next. -->
            <template v-else-if="view === 'pending'">
                <Card class="border-primary-fill/25 bg-primary-fill/[0.07]">
                    <div class="flex flex-wrap items-start gap-4">
                        <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                                <Icon name="bolt" class="text-base text-link" />
                                <span class="text-2xs font-semibold uppercase tracking-wider text-link">Approve a run</span>
                            </div>
                            <h1 class="mt-3 text-2xl font-semibold leading-tight tracking-tight">
                                {{ offer?.name }}
                                <span
                                    v-if="offer?.probation"
                                    class="ml-1.5 align-middle rounded bg-content/10 px-1.5 py-0.5 text-2xs font-medium uppercase tracking-wide text-muted"
                                    >new</span
                                >
                            </h1>
                            <p class="mt-1 text-xs text-subtle">by {{ offer?.publisher }}</p>
                            <p class="mt-2 text-sm text-muted">{{ offer?.description }}</p>
                        </div>

                        <div class="shrink-0 rounded-lg border border-line bg-card p-4 text-center @sm:w-40">
                            <div class="text-3xl font-semibold leading-none tabular-nums">{{ n(offer?.credits ?? 0) }}</div>
                            <p class="mt-1 text-2xs uppercase tracking-wider text-subtle">credits</p>
                            <p v-if="offer?.credits_remaining !== undefined" class="mt-2 text-xs text-muted">
                                {{ n(offer.credits_remaining) }} left today
                            </p>
                        </div>
                    </div>
                </Card>

                <!-- The agent's own words, labelled as such. Both of these are the one part of this page the
                     calling agent authored, and a reader is entitled to know which part that is. -->
                <Card v-if="offer?.why" class="mt-3">
                    <p class="text-2xs font-semibold uppercase tracking-wider text-subtle">Why your agent wants this</p>
                    <p class="mt-1.5 text-sm text-content">{{ offer.why }}</p>
                </Card>

                <Card class="mt-3">
                    <p class="text-2xs font-semibold uppercase tracking-wider text-subtle">What will be sent</p>
                    <pre
                        class="mt-2 max-h-64 overflow-auto rounded-md border border-line bg-canvas p-3 text-xs leading-relaxed text-muted"
                    ><code>{{ requestBody }}</code></pre>
                    <p class="mt-2 text-2xs text-subtle">
                        Forwarded to {{ offer?.publisher }} signed by intentic. They never learn who you are, and you never hold a credential of
                        theirs.
                    </p>
                </Card>

                <Notice
                    v-if="!affordable"
                    class="mt-3"
                    :of="{
                        tone: `warning`,
                        title: `Not enough credits left today.`,
                        detail: `The allowance comes back in full at the next reset. Approving now would be refused, and nothing would be charged.`,
                    }"
                />

                <div class="mt-4 flex flex-wrap items-center gap-3">
                    <Button
                        :label="`Approve · ${n(offer?.credits ?? 0)} credits`"
                        class="ui-button-loud"
                        :loading="working"
                        :disabled="!affordable"
                        @click="settle(true)"
                    />
                    <Button label="Skip this run" severity="secondary" :loading="working" @click="settle(false)" />
                    <span class="ml-auto flex items-center gap-1.5 text-xs tabular-nums text-subtle">
                        <Icon name="clock" class="text-sm" />
                        expires in {{ countdown }}
                    </span>
                </div>

                <!-- The four things a reader silently asks at this button. Same four as the membership page,
                     narrowed to this decision. -->
                <p class="mt-4 text-xs text-muted">
                    This approves one run and nothing else: a second run asks again. If the service doesn't answer, the credits come straight back and
                    no receipt is written.
                </p>
            </template>

            <Card v-else-if="view === 'approved'" class="border-success/40 bg-success/[0.07]">
                <Row
                    flush
                    :heading="2"
                    icon="check-circle"
                    tone="success"
                    title="Approved"
                    description="Head back to your terminal: the run starts as soon as your agent asks again. You can close this tab."
                />
            </Card>

            <Card v-else-if="view === 'declined'">
                <Row
                    flush
                    :heading="2"
                    icon="times"
                    title="Skipped"
                    description="Nothing was charged. Your agent has been told to carry on without the service."
                />
            </Card>

            <Card v-else-if="view === 'expired'">
                <Row
                    flush
                    :heading="2"
                    icon="clock"
                    tone="warning"
                    title="This approval expired"
                    description="Approvals stand for ten minutes so an old link can never spend anything. Nothing was charged: ask your agent again if you still want the run."
                />
            </Card>

            <Card v-else-if="view === 'spent'" class="border-success/40 bg-success/[0.07]">
                <Row
                    flush
                    :heading="2"
                    icon="check-circle"
                    tone="success"
                    title="Already run"
                    description="You approved this and the run has happened. One approval covers one run, so a repeat asks again."
                />
            </Card>

            <Card v-else>
                <Row
                    flush
                    :heading="2"
                    icon="info-circle"
                    title="Already answered"
                    description="This approval has been settled somewhere else: another tab, most likely. Nothing was charged twice."
                />
            </Card>

            <Notice v-if="error" :of="error" class="mt-4" />
        </div>
    </div>
</template>
