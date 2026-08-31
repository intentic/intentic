<script setup lang="ts">
import type { ProviderService, ProviderServicesState, ServiceProbeResult } from "@intentic-app/api-contract";
import {
    Button,
    CopyButton,
    type IconName,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    type RowTone,
    SkeletonRows,
    StatusBadge,
    type StatusVariant,
    ui,
    useLoadingReveal,
} from "@intentic/ui";
import { noticeFrom, useAsyncAction } from "@intentic/ui/async";
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
 * a screen is a copy free to drift from the one the algorithm applies. What changed is the SHAPE they are in:
 * they used to be one 120-word paragraph of `text-xs text-muted` carrying nine figures, which is a paragraph
 * nobody looks a threshold up in. Each is a row with the number in the fact column now, so "what is the price
 * band" is answered by scanning rather than by reading; the prose that is genuinely prose (what the health
 * check does) stays prose.
 *
 * A signing secret appears exactly twice, when it is minted and when it is rotated, because the platform
 * keeps only an encrypted copy and never answers one back. That is why it gets the app's loudest box, a
 * warning <Notice>, rather than a line in a list: it is the one thing on this page that cannot be recovered
 * by reloading. (It used to be a hand-rolled `border-warn/40 bg-warn/5` div, and the app has no `warn` colour
 * token — the tokens are `warning` and `success` — so the loudest box on the page was rendering untinted.)
 *
 * LAID OUT AS GROUPED ROWS, like every other settings tab. This was one <Card> holding six `<h3
 * class="text-xs font-semibold">` headings, a body set a size under the rest of the app, listings drawn as
 * bare stacked divs with no surface between them, and a seven-field form whose only labels were placeholders. */

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

// Only once the wait has earned it. See the payouts tab, which reads the other half of the same account.
const outline = useLoadingReveal(
    computed(() => state.value === null && loadError.value === undefined),
    computed(() => `provider-services`),
);

const rules = computed(() => state.value?.rules);
const services = computed(() => state.value?.services ?? []);
const ready = computed(() => state.value?.holdsAnyPublisher === true && state.value.payoutsEnabled);

/* WHAT A LISTING'S STATE LOOKS LIKE, as one table rather than as a sentence in the fact column. The old screen
 * put "Live, on probation" and "Draft. Nobody can see or run this yet" in `text-2xs text-muted` where every
 * other list in the app wears a <StatusBadge>: two words at a glance, the same pill on this page as on the
 * fleet board. What the sentence was carrying (what to do about it) belongs to `nextStep` below, and is said
 * there once. */
const STATUS: Record<ProviderService[`status`], { label: string; variant: StatusVariant; icon: IconName; tone: RowTone }> = {
    draft: { label: `Draft`, variant: `neutral`, icon: `file-edit`, tone: `default` },
    probation: { label: `On probation`, variant: `warning`, icon: `bolt`, tone: `warning` },
    listed: { label: `Live`, variant: `success`, icon: `bolt`, tone: `success` },
    suspended: { label: `Suspended`, variant: `danger`, icon: `exclamation-circle`, tone: `danger` },
};

// What the provider should do next, in one sentence, computed rather than guessed at by reading the badge.
const nextStep = (service: ProviderService): string => {
    if (service.status === `draft`) {
        return service.probedAt === undefined
            ? `Nobody can see or run this yet. Run the health check, then publish.`
            : `Health check passed. Publish while it's fresh — it's good for ${rules.value?.probeFreshMinutes ?? 60} minutes.`;
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

/* THE PUBLISHED THRESHOLDS AS ROWS: a name, what it means where that is not obvious, and the platform's own
 * figure in the fact column. Built here rather than spelled down the template so the nine numbers arrive
 * through exactly one expression each. */
const ruleRows = computed(() => {
    const current = rules.value;
    if (current === undefined) {
        return [];
    }
    return [
        { key: `band`, title: `Price band`, description: undefined, fact: `${current.minCredits}–${current.maxCredits} credits per run` },
        {
            key: `probation`,
            title: `While on probation`,
            description: `Lifts after ${current.graduationRuns} served runs. Until then every listing is badged as new.`,
            fact: `max ${current.probationMaxCredits} credits`,
        },
        {
            key: `suspension`,
            title: `Suspended automatically`,
            description: `Or after ${current.canaryFailures} health checks failed in a row.`,
            fact: `over ${Math.round(current.maxRefundRate * 100)}% of ${current.watchWindowRuns} runs`,
        },
        { key: `price`, title: `Price changes`, description: undefined, fact: `once every ${current.priceChangeHours} hours` },
        { key: `cap`, title: `Live listings`, description: undefined, fact: `${current.maxServicesPerOwner} per account` },
    ];
});

/* WHAT THE PLATFORM WILL REFUSE, checked here so it is said next to the field rather than by a round trip.
 * These are the contract's own bounds (ServiceListingInputSchema): a slug shaped like a slug, a name and a
 * description inside their lengths, a real URL and a positive price. The old form let all of it through and
 * answered a malformed slug with a red box under a submit button. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/u;
const NAME_MAX = 60;
const DESCRIPTION_MAX = 400;

const httpUrl = (value: string): boolean => {
    try {
        return /^https?:$/u.test(new URL(value).protocol);
    } catch {
        return false;
    }
};

const slugValid = computed(() => SLUG.test(form.slug.trim().toLowerCase()));
const publisherValid = computed(() => SLUG.test(form.publisher.trim().toLowerCase()));
const urlValid = computed(() => httpUrl(form.upstreamUrl.trim()));
const formReady = computed(
    () =>
        slugValid.value &&
        publisherValid.value &&
        form.name.trim().length > 0 &&
        form.description.trim().length > 0 &&
        urlValid.value &&
        Number.isInteger(form.creditsPerRun) &&
        form.creditsPerRun > 0,
);

const act = async (slug: string, what: () => Promise<unknown>, fallback: string): Promise<void> => {
    actingOn.value = slug;
    await runAct(async () => {
        await what();
        await load();
    }, fallback);
    actingOn.value = ``;
};

const create = async (): Promise<void> => {
    if (!formReady.value) {
        return;
    }
    await runCreate(async () => {
        // Normalised on the way out rather than on the way in: a provider typing "Acme" into the publisher
        // field means the same name the platform stores as `acme`, and being refused for a capital letter is
        // a round trip spent on nothing.
        const { service, secret } = await apiClient.creator.services.draft({
            ...form,
            slug: form.slug.trim().toLowerCase(),
            publisher: form.publisher.trim().toLowerCase(),
            name: form.name.trim(),
            description: form.description.trim(),
            upstreamUrl: form.upstreamUrl.trim(),
        });
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
</script>

<template>
    <div class="@container flex flex-col gap-6">
        <Notice v-if="loadError" :of="loadError" />
        <p v-else-if="state && !state.enabled" :class="ui.emptyState()">
            This platform doesn't take self-serve service listings. Its catalog is written by its operator.
        </p>

        <template v-else>
            <!-- WHAT DOES NOT WAIT ON THE READ: "How admission works" keeps its label and its prose on screen
                 from the first frame, because neither the group's name nor the explanation of the health
                 check changes with anything the answer can say. What still waits is what the answer carries:
                 the gates, the thresholds' figures, the listings and the form. -->
            <!-- ══ THE UNRECOVERABLE VALUE ════════════════════════════════════════════════════════════════
                 The app's one tinted message box, in the tone that means "this will cost you something if you
                 ignore it". Dismissed by the provider and by nothing else. -->
            <Notice v-if="shownSecret" tone="warning" icon="key" dismiss-label="Dismiss" @dismiss="shownSecret = null">
                <span class="block font-medium">Signing key for {{ shownSecret.slug }}</span>
                <span class="mt-0.5 block text-2xs">
                    This is the only time it's shown. We keep an encrypted copy and can't read it back. Your endpoint verifies every forwarded call
                    against it.
                </span>
                <span class="mt-2 flex flex-wrap items-center gap-2">
                    <code class="min-w-0 flex-1 truncate rounded-md border border-line bg-canvas px-2.5 py-1.5 font-mono text-2xs text-content">{{
                        shownSecret.secret
                    }}</code>
                    <CopyButton :text="shownSecret.secret" label="Copy" />
                </span>
            </Notice>

            <!-- ══ THE TWO IDENTITY GATES ═════════════════════════════════════════════════════════════════
                 First, because nothing below them is worth reading otherwise. Each gate is a row wearing the
                 glyph its state deserves, and each is a LINK to the tab that clears it: the old copy said
                 "both live on Getting paid" and left the reader to find it. The literal "✓" and "1." typed
                 into a span are gone with it; a passed gate was painted `text-ok`, which is not a colour this
                 app has, so it rendered in the paragraph's own colour and said nothing at all. -->
            <RowGroup v-if="state && !ready" label="Before you can list">
                <RouterLink :to="{ name: `settings`, params: { tab: `payouts` } }" class="block">
                    <Row
                        interactive
                        chevron
                        :icon="state.holdsAnyPublisher ? `check-circle` : `circle`"
                        :tone="state.holdsAnyPublisher ? `success` : `default`"
                        title="Prove a publisher name is yours"
                        :description="state.holdsAnyPublisher ? `Done.` : `A file in a repository the registry already lists under that name.`"
                    />
                </RouterLink>
                <RouterLink :to="{ name: `settings`, params: { tab: `payouts` } }" class="block">
                    <Row
                        interactive
                        chevron
                        :icon="state.payoutsEnabled ? `check-circle` : `circle`"
                        :tone="state.payoutsEnabled ? `success` : `default`"
                        title="Connect somewhere to be paid"
                        :description="state.payoutsEnabled ? `Done.` : `Stripe collects the details on its own pages.`"
                    />
                </RouterLink>
            </RowGroup>

            <!-- ══ HOW ADMISSION WORKS ════════════════════════════════════════════════════════════════════
                 The narrative first, then the thresholds as facts. Every figure below is the platform's. -->
            <!-- The thresholds are a record list: short lines of fact, read in bulk. The prose above them is a
                 note on the same surface, so it takes the group's tier rather than restating `px-4.5 py-3.5`. -->
            <RowGroup label="How admission works">
                <RowNote>
                    No review queue. Prove your publisher name, connect payouts, and pass a health check: one signed call that succeeds, two bad ones
                    that fail. Pass and you're live on probation. Same five-minute timeout as a paid run, so slow endpoints take time.
                </RowNote>
                <template v-if="rules">
                    <Row v-for="rule in ruleRows" :key="rule.key" :title="rule.title" :description="rule.description">
                        <template #meta
                            ><span class="text-content">{{ rule.fact }}</span></template
                        >
                    </Row>
                </template>
                <!-- THE THRESHOLDS ARE THE ONE PART OF THIS GROUP THAT WAITS: the figures are the platform's
                     own numbers, so before the read lands the group stands with its label and prose and, once
                     the wait has earned it, an outline of exactly the five rows that are coming. -->
                <template v-else-if="outline">
                    <span class="sr-only" role="status">Reading your service listings…</span>
                    <SkeletonRows :rows="5" :lead="false" description control />
                </template>
            </RowGroup>

            <!-- ══ WHAT YOU ALREADY HOLD ══════════════════════════════════════════════════════════════════
                 One surface, hairline-divided, so five listings read as five things rather than as one column
                 of paragraphs. The row's header carries the name, the state and what to do next; the facts,
                 the last health check and the four verbs hang off it in #below, where they have the width
                 they need and cannot squeeze the name. -->
            <RowGroup v-if="services.length > 0" label="Your listings" :count="services.length">
                <Row
                    v-for="service in services"
                    :key="service.slug"
                    :icon="STATUS[service.status].icon"
                    :tone="STATUS[service.status].tone"
                    :title="service.name"
                    :description="nextStep(service)"
                >
                    <template #meta
                        ><StatusBadge :variant="STATUS[service.status].variant" :label="STATUS[service.status].label" size="xs"
                    /></template>
                    <template #below>
                        <div class="flex flex-col gap-3">
                            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                                <span class="font-mono text-muted">{{ service.slug }}</span>
                                <span>{{ service.creditsPerRun }} credits/run</span>
                                <span>{{ service.servedRuns }} served</span>
                                <span>{{ service.refundedRuns }} refunded</span>
                            </div>

                            <!-- ALL THREE CHECKS, PASSED OR NOT: "one of three failed" without saying which is
                                 a support ticket waiting to happen. Real glyphs, in the two colours the app
                                 has for pass and fail. -->
                            <div v-if="probes[service.slug]" class="flex flex-col gap-1">
                                <p v-for="check in probes[service.slug]?.checks ?? []" :key="check.name" class="flex items-start gap-1.5 text-2xs">
                                    <Icon
                                        :name="check.passed ? `check-circle` : `exclamation-circle`"
                                        class="mt-px shrink-0"
                                        :class="check.passed ? `text-success` : `text-danger`"
                                    />
                                    <span class="min-w-0 text-muted"
                                        ><span class="font-medium text-content">{{ check.name }}</span
                                        >: {{ check.detail }}</span
                                    >
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
                                <!-- The one accent verb in the row: publishing is what commits. -->
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
                    </template>
                </Row>
                <RowNote v-if="actNotice" variant="block">
                    <div></div>
                </RowNote>
            </RowGroup>

            <!-- ══ ADDING ONE ═════════════════════════════════════════════════════════════════════════════
                 EVERY FIELD IS LABELLED, and says what it wants under itself. This was seven bare inputs whose
                 only labels were placeholders — which disappear the moment anybody types, so a provider three
                 fields in had no way to check what the second one was for — and one textarea holding a JSON
                 blob with no label and no placeholder at all. The rules the platform will apply are stated at
                 the field they apply to, so a malformed slug is caught here rather than by a red box after a
                 round trip. -->
            <RowGroup v-if="ready && rules" label="List a service">
                <RowNote variant="block">
                    <form class="flex flex-col gap-4" @submit.prevent="create">
                        <div class="grid gap-4 @xl:grid-cols-2">
                            <label class="ui-field">
                                <span class="ui-field-label">Slug</span>
                                <input v-model="form.slug" spellcheck="false" autocapitalize="off" placeholder="acme-research" :class="ui.input()" />
                                <span class="text-2xs" :class="form.slug.length > 0 && !slugValid ? `text-danger` : `text-subtle`">
                                    Lower case, digits and hyphens. This is the id agents ask for by name.
                                </span>
                            </label>

                            <label class="ui-field">
                                <span class="ui-field-label">Publisher</span>
                                <input v-model="form.publisher" spellcheck="false" autocapitalize="off" placeholder="acme" :class="ui.input()" />
                                <span class="text-2xs text-subtle">A name you've proved on Getting paid.</span>
                            </label>

                            <label class="ui-field @xl:col-span-2">
                                <span class="ui-field-label">Name</span>
                                <input v-model="form.name" :maxlength="NAME_MAX" placeholder="Acme Deep Research" :class="ui.input()" />
                                <span class="text-2xs text-subtle">What members see in the catalog. Up to {{ NAME_MAX }} characters.</span>
                            </label>

                            <label class="ui-field @xl:col-span-2">
                                <span class="ui-field-label">Description</span>
                                <textarea v-model="form.description" :maxlength="DESCRIPTION_MAX" rows="3" :class="ui.input()" />
                                <span class="text-2xs text-subtle">
                                    The only prose a member reads before paying. {{ form.description.length }}/{{ DESCRIPTION_MAX }}.
                                </span>
                            </label>

                            <label class="ui-field @xl:col-span-2">
                                <span class="ui-field-label">Endpoint</span>
                                <input
                                    v-model="form.upstreamUrl"
                                    type="url"
                                    spellcheck="false"
                                    autocapitalize="off"
                                    placeholder="https://api.acme.dev/research"
                                    :class="ui.input('font-mono')"
                                />
                                <span class="text-2xs" :class="form.upstreamUrl.length > 0 && !urlValid ? `text-danger` : `text-subtle`">
                                    The URL we forward a paid run to, signed with the key you get back.
                                </span>
                            </label>

                            <label class="ui-field">
                                <span class="ui-field-label">Price</span>
                                <input
                                    v-model.number="form.creditsPerRun"
                                    type="number"
                                    :min="rules.minCredits"
                                    :max="rules.maxCredits"
                                    step="1"
                                    :class="ui.input('w-32 tabular-nums')"
                                />
                                <span class="text-2xs text-subtle">
                                    Credits per run, {{ rules.minCredits }}–{{ rules.maxCredits }}. Capped at {{ rules.probationMaxCredits }} until it
                                    graduates.
                                </span>
                            </label>

                            <label class="ui-field @xl:col-span-2">
                                <span class="ui-field-label">Sample request</span>
                                <textarea v-model="form.sampleRequest" rows="3" spellcheck="false" :class="ui.input('font-mono')" />
                                <span class="text-2xs text-subtle">The body the health check posts to your endpoint. It has to answer this one.</span>
                            </label>
                        </div>

                        <div class="flex justify-end">
                            <Button type="submit" label="Create draft" :loading="creating" :disabled="creating || !formReady" />
                        </div>
                        <Notice v-if="createNotice" :of="createNotice" />
                    </form>
                </RowNote>
            </RowGroup>
        </template>
    </div>
</template>
