<script setup lang="ts">
import type { ProviderService, ProviderServicesState, ServiceProbeResult } from "@intentic-app/api-contract";
import { Card, ui, useLoadingReveal, type NoticeModel, Notice, Row } from "@intentic/ui";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, onMounted, reactive, ref } from "vue";
import { apiClient } from "../../composables/useApi";

/* OFFERING A PAID SERVICE: the provider's side of open admission, which used to be a Discord conversation
 * and an operator writing a row by hand.
 *
 * The screen's order is the order of the work: whether this account can list at all, what the rules are, the
 * listings it already holds, and then the form to add one. A provider who cannot pass the identity gates sees
 * that FIRST, because everything below it would be an afternoon spent building against a shut door.
 *
 * THE RULES ARE RENDERED FROM THE PLATFORM'S OWN NUMBERS, never from constants here. The whole promise of
 * rules-based admission is that a provider can look the thresholds up before they build, and a second copy on
 * a screen is a copy free to drift from the one the algorithm applies.
 *
 * A signing secret appears exactly twice, when it is minted and when it is rotated, because the platform
 * keeps only an encrypted copy and never answers one back. That is why it gets its own loud box rather than a
 * line in a list: it is the one thing on this page that cannot be recovered by reloading. */

const state = ref<ProviderServicesState | null>(null);
const loadError = ref<NoticeModel | undefined>(undefined);

// The one secret currently on screen, and which listing it belongs to. Cleared by the provider, never by a
// reload. A box that vanished on its own would be the worst possible behaviour for an unrecoverable value.
const shownSecret = ref<{ slug: string; secret: string } | null>(null);
// The last probe verdict per listing, so a provider fixing an endpoint can see all three checks at once.
const probes = reactive<Record<string, ServiceProbeResult>>({});

const { busy: creating, notice: createNotice, run: runCreate } = useAsyncAction();
const { busy: acting, notice: actNotice, run: runAct } = useAsyncAction();
// Which listing the shared action flag belongs to, so one row's button spins rather than all of them.
const actingOn = ref(``);

const blank = () => ({ slug: ``, publisher: ``, name: ``, description: ``, upstreamUrl: ``, creditsPerRun: 5, sampleRequest: `{"query":"…"}` });
const form = reactive(blank());

const load = async (): Promise<void> => {
    try {
        state.value = await apiClient.creator.services.list();
    } catch (err) {
        loadError.value = noticeFrom(err, `Couldn't load your service listings.`);
    }
};

onMounted(load);

// Only once the wait has earned it. See the payouts card, which reads the other half of the same account.
const outline = useLoadingReveal(
    computed(() => state.value === null && loadError.value === undefined),
    computed(() => `provider-services`),
);

const rules = computed(() => state.value?.rules);
const services = computed(() => state.value?.services ?? []);
const ready = computed(() => state.value?.holdsAnyPublisher === true && state.value.payoutsEnabled);

const STATUS_LABEL: Record<ProviderService[`status`], string> = {
    draft: `Draft. Nobody can see or run this yet`,
    probation: `Live, on probation`,
    listed: `Live`,
    suspended: `Suspended`,
};

// What the provider should do next, in one sentence, computed rather than guessed at by reading the badge.
const nextStep = (service: ProviderService): string => {
    if (service.status === `draft`) {
        return service.probedAt === undefined
            ? `Run the health check, then publish.`
            : `Health check passed. Publish while it's fresh. It's good for ${rules.value?.probeFreshMinutes ?? 60} minutes.`;
    }
    if (service.status === `probation`) {
        const target = rules.value?.graduationRuns ?? 0;
        return `${service.servedRuns} of ${target} runs served. At ${target} the price ceiling and the "new" badge lift.`;
    }
    if (service.status === `suspended`) {
        return service.suspendedFor ?? `Suspended.`;
    }
    return `Graduated. The full price band is open to this listing.`;
};

const act = async (slug: string, what: () => Promise<unknown>, fallback: string): Promise<void> => {
    actingOn.value = slug;
    await runAct(async () => {
        await what();
        await load();
    }, fallback);
    actingOn.value = ``;
};

const create = async (): Promise<void> => {
    await runCreate(async () => {
        const { service, secret } = await apiClient.creator.services.draft({ ...form, slug: form.slug.trim().toLowerCase() });
        shownSecret.value = { slug: service.slug, secret };
        Object.assign(form, blank());
        await load();
    }, `That listing couldn't be created.`);
};

const probe = async (slug: string): Promise<void> => {
    await act(
        slug,
        async () => {
            probes[slug] = await apiClient.creator.services.probe({ slug });
        },
        `The health check couldn't run.`,
    );
};

const publish = (slug: string) => act(slug, () => apiClient.creator.services.publish({ slug }), `That listing couldn't go live.`);
const withdraw = (slug: string) => act(slug, () => apiClient.creator.services.withdraw({ slug }), `That listing couldn't be withdrawn.`);
const rotate = (slug: string) =>
    act(
        slug,
        async () => {
            const { secret } = await apiClient.creator.services.rotateSecret({ slug });
            shownSecret.value = { slug, secret };
        },
        `That key couldn't be replaced.`,
    );

const copySecret = async (): Promise<void> => {
    await navigator.clipboard?.writeText(shownSecret.value?.secret ?? ``).catch(() => undefined);
};
</script>

<template>
    <Card>
        <Row
            flush
            :heading="2"
            icon="bolt"
            title="Offer a paid service"
            description="List an endpoint of yours and be paid in members' credits, without asking anyone."
        />

        <div class="mt-3 flex flex-col gap-4">
            <Notice v-if="loadError" :of="loadError" />
            <p v-else-if="state && !state.enabled" class="text-xs text-muted">
                This platform doesn't take self-serve service listings. Its catalog is written by its operator.
            </p>

            <template v-else-if="outline">
                <!-- The same wait the payouts card draws, for the same reason: the masthead is instant and the
                     body is a round-trip, so a titled card sits empty until the listings answer. What is outlined
                     is only what every provider gets: the admission rules, which are rendered from the
                     platform's own numbers and are therefore the one block guaranteed to land. Listings and the
                     create form are withheld: most providers have neither, and promising rows that never arrive
                     is worse than promising nothing. -->
                <div class="flex flex-col gap-2" role="status" aria-busy="true">
                    <span class="sr-only">Reading your service listings…</span>
                    <span class="skeleton block h-3 w-36" aria-hidden="true" />
                    <!-- TWO PARAGRAPHS, SPACED AS TWO. The lines inside a paragraph sit a leading apart and the
                         paragraphs sit a gap apart, so the outline reads as prose. Given one even gap instead,
                         six identical bars read as a table nobody is about to see. The last line of each is
                         short because the last line of a wrapped paragraph is. -->
                    <div
                        v-for="(paragraph, block) in [
                            [`w-full`, `w-full`, `w-4/5`],
                            [`w-full`, `w-11/12`, `w-3/5`],
                        ]"
                        :key="block"
                        class="flex flex-col gap-1"
                        aria-hidden="true"
                    >
                        <span v-for="(width, line) in paragraph" :key="line" class="skeleton block h-2.5" :class="width" />
                    </div>
                </div>
            </template>

            <template v-else-if="state && rules">
                <!-- The unrecoverable value, in the loudest box on the page. -->
                <div v-if="shownSecret" class="flex flex-col gap-2 rounded border border-warn/40 bg-warn/5 p-3">
                    <h3 class="text-xs font-semibold">Signing key for {{ shownSecret.slug }}</h3>
                    <p class="text-xs text-muted">
                        This is the only time it's shown. We keep an encrypted copy and can't read it back. Your endpoint verifies every forwarded
                        call against it.
                    </p>
                    <div class="flex items-center gap-2">
                        <code class="flex-1 truncate rounded bg-overlay/50 px-2 py-1 text-2xs">{{ shownSecret.secret }}</code>
                        <Button label="Copy" severity="secondary" size="small" @click="copySecret" />
                        <Button label="Done" size="small" @click="shownSecret = null" />
                    </div>
                </div>

                <!-- The two identity gates, first, because nothing below them is worth reading otherwise. -->
                <div v-if="!ready" class="flex flex-col gap-1.5">
                    <h3 class="text-xs font-semibold">Before you can list</h3>
                    <p class="text-xs text-muted">
                        <span :class="state.holdsAnyPublisher ? `text-ok` : `text-content`">{{ state.holdsAnyPublisher ? `✓` : `1.` }}</span>
                        Prove a publisher name is yours.
                        <span :class="state.payoutsEnabled ? `text-ok` : `text-content`">{{ state.payoutsEnabled ? `✓` : `2.` }}</span>
                        Connect somewhere to be paid. Both live on Getting paid.
                    </p>
                </div>

                <!-- The published rules, stated from the platform's own numbers. -->
                <div class="flex flex-col gap-1.5">
                    <h3 class="text-xs font-semibold">How admission works</h3>
                    <p class="text-xs text-muted">
                        There's no review queue. You prove a publisher name, connect payouts, and pass a health check: three calls to your endpoint,
                        one correctly signed that has to answer, and two deliberately bad ones that have to be refused. Passing puts you live
                        immediately, on probation. The check gives your endpoint the same five minutes a paid run gets, so a slow one takes a while to
                        come back.
                    </p>
                    <p class="text-xs text-muted">
                        Probation caps the price at {{ rules.probationMaxCredits }} credits and badges every listing as new. It lifts after
                        {{ rules.graduationRuns }} served runs. Above {{ Math.round(rules.maxRefundRate * 100) }}% of your last
                        {{ rules.watchWindowRuns }} runs failing to answer, the listing is suspended automatically, so is one that fails
                        {{ rules.canaryFailures }} health checks in a row. Prices move once every {{ rules.priceChangeHours }} hours, inside
                        {{ rules.minCredits }}–{{ rules.maxCredits }} credits. {{ rules.maxServicesPerOwner }} live listings per account.
                    </p>
                </div>

                <!-- What you already hold. -->
                <div v-if="services.length > 0" class="flex flex-col gap-3">
                    <h3 class="text-xs font-semibold">Your listings</h3>
                    <div v-for="service in services" :key="service.slug" class="flex flex-col gap-1.5 border-t border-line pt-3">
                        <div class="flex items-baseline justify-between gap-2">
                            <span class="text-sm font-medium">{{ service.name }}</span>
                            <span class="text-2xs text-muted">{{ STATUS_LABEL[service.status] }}</span>
                        </div>
                        <p class="text-xs text-muted">
                            <span class="font-mono">{{ service.slug }}</span> · {{ service.creditsPerRun }} credits/run ·
                            {{ service.servedRuns }} served, {{ service.refundedRuns }} refunded
                        </p>
                        <p class="text-xs text-muted">{{ nextStep(service) }}</p>

                        <!-- All three checks, passed or not: "one of three failed" without saying which is a
                             support ticket waiting to happen. -->
                        <div v-if="probes[service.slug]" class="flex flex-col gap-0.5">
                            <p v-for="check in probes[service.slug]?.checks ?? []" :key="check.name" class="text-2xs text-muted">
                                <span :class="check.passed ? `text-ok` : `text-danger`">{{ check.passed ? `✓` : `✕` }}</span>
                                {{ check.name }}: {{ check.detail }}
                            </p>
                        </div>

                        <div class="flex flex-wrap gap-2">
                            <Button
                                label="Health check"
                                severity="secondary"
                                size="small"
                                :loading="acting && actingOn === service.slug"
                                @click="probe(service.slug)"
                            />
                            <Button
                                v-if="service.status === `draft` || service.status === `suspended`"
                                label="Publish"
                                size="small"
                                :loading="acting && actingOn === service.slug"
                                @click="publish(service.slug)"
                            />
                            <Button
                                v-if="service.status === `probation` || service.status === `listed`"
                                label="Withdraw"
                                severity="secondary"
                                size="small"
                                :loading="acting && actingOn === service.slug"
                                @click="withdraw(service.slug)"
                            />
                            <Button
                                label="New signing key"
                                severity="secondary"
                                size="small"
                                :loading="acting && actingOn === service.slug"
                                @click="rotate(service.slug)"
                            />
                        </div>
                    </div>
                    <Notice v-if="actNotice" :of="actNotice" />
                </div>

                <!-- Adding one. -->
                <div v-if="ready" class="flex flex-col gap-2 border-t border-line pt-3">
                    <h3 class="text-xs font-semibold">List a service</h3>
                    <input v-model="form.slug" placeholder="slug, e.g. acme-research" :class="ui.input()" />
                    <input v-model="form.publisher" placeholder="publisher name you've proved" :class="ui.input()" />
                    <input v-model="form.name" placeholder="name members see" :class="ui.input()" />
                    <textarea
                        v-model="form.description"
                        placeholder="what it does, the only prose a member reads before paying"
                        rows="2"
                        :class="ui.input()"
                    />
                    <input v-model="form.upstreamUrl" placeholder="https://… the endpoint we call" :class="ui.input()" />
                    <input v-model.number="form.creditsPerRun" type="number" placeholder="credits per run" :class="ui.input()" />
                    <textarea v-model="form.sampleRequest" rows="2" :class="ui.input(`font-mono`)" />
                    <p class="text-2xs text-muted">
                        The sample request is a body your service actually answers. We send it as the health check, and members' agents read it as the
                        worked example of your request shape.
                    </p>
                    <div>
                        <Button label="Create draft" size="small" :loading="creating" @click="create" />
                    </div>
                    <Notice v-if="createNotice" :of="createNotice" />
                </div>
            </template>
        </div>
    </Card>
</template>
