<script setup lang="ts">
import { githubRepoOf } from "@intentic/registry";
import { BrandMark, Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { computed } from "vue";
import { checksOk, checksProblem, type DiscoverListing, splitListingName } from "./discoverListing";

// One listing, read before it's run: where this product's trust argument gets made explicit rather than implied. Source
// identity, scanner, agent gate and human review are separate guarantees shown as separate lines, not one badge. The
// owner's own agent read is offered as primary where no human has reviewed the code, secondary otherwise.

const { listing, canInstall, installing } = defineProps<{
    listing: DiscoverListing;
    /** Installing is the owner's alone; everyone else browses. */
    canInstall: boolean;
    installing: boolean;
    failure?: NoticeModel | undefined;
}>();

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ install: []; audit: [] }>();

const name = computed(() => splitListingName(listing.entry.name));
const problem = computed(() => checksProblem(listing.entry));
const loads = computed(() => checksOk(listing.entry));
const verified = computed(() => listing.entry.trust === `verified`);
const ref40 = computed(() => listing.entry.install?.ref);
const shortRef = computed(() => ref40.value?.slice(0, 10));
const repo = computed(() => githubRepoOf(listing.entry.install));
const sourceHref = computed(() => {
    const url = listing.entry.install?.url;
    if (url === undefined) {
        return undefined;
    }
    // Links at the exact commit: a branch link could show code that isn't what would be installed.
    return repo.value !== undefined && ref40.value !== undefined ? `https://github.com/${repo.value}/tree/${ref40.value}` : url.replace(/\.git$/, ``);
});

// Offered exactly when there's a commit to read; everything else on the panel renders regardless of installability.
const auditable = computed(() => ref40.value !== undefined && listing.state.kind !== `blocked`);
const actionable = computed(() => listing.state.action !== undefined && canInstall);
// Leads wherever the registry hasn't vouched for the code.
const auditLeads = computed(() => auditable.value && !verified.value);

</script>

<template>
    <!-- The footer wraps on purpose: the primary label is a full sentence, and unwrapped on a phone the control that matters most would get clipped. -->
    <Modal v-model:open="open" size="md">
        <template #header>
            <div class="flex min-w-0 items-center gap-3">
                <BrandMark :size="32" :name="listing.entry.name" :art="listing.entry.art" :logo="listing.entry.logo" :icon="listing.entry.icon" />
                <div class="min-w-0">
                    <div class="truncate font-medium text-content">{{ name.title }}</div>
                    <div class="truncate text-2xs text-subtle">{{ listing.entry.name }}</div>
                </div>
            </div>
        </template>

        <div class="flex flex-col gap-4">
            <p v-if="listing.entry.description" class="text-sm leading-relaxed text-muted">{{ listing.entry.description }}</p>

            <!-- Plain facts only (name, cost, popularity); anything that's a safety claim is stated in full below. -->
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                <span v-if="listing.entry.version">{{ listing.entry.version }}</span>
                <span v-if="listing.entry.stars !== undefined" class="inline-flex items-center gap-0.5"
                    ><Icon name="star" />{{ listing.entry.stars }}</span
                >
                <span v-if="listing.entry.category">{{ listing.entry.category }}</span>
                <a
                    v-if="listing.entry.homepage"
                    :href="listing.entry.homepage"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="inline-flex items-center gap-1 text-link hover:underline"
                >
                    Homepage <Icon name="external-link" />
                </a>
            </div>

            <!-- A non-default state is said before anything else, so a reader never has to reach the button to learn it. -->
            <Notice v-if="listing.state.kind === `blocked`" tone="danger">
                <b>Blocked.</b> {{ listing.state.reason }} It stays listed rather than disappearing, because anyone who already installed it is the
                person this most concerns.
            </Notice>
            <Notice v-else-if="listing.state.kind === `unavailable`" tone="info">{{ listing.state.reason }}</Notice>
            <Notice v-else-if="listing.state.kind === `installed`" tone="info">
                Already installed in this sandbox, at this commit. Manage it on the Extensions tab.
            </Notice>
            <Notice v-else-if="listing.state.kind === `update`" tone="info">
                You have this installed at <code class="ui-code">{{ listing.state.installedRef?.slice(0, 10) }}</code
                >. The listing points at <code class="ui-code">{{ shortRef }}</code
                >. Updating replaces the code wholesale and re-asks for broader declared host API access; code internals still need review.
            </Notice>

            <!--
                Three different parties guarantee three different things, kept as separate lines rather than one badge, ordered by how much each
                actually settles.
            -->
            <div class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
                <div :class="ui.sectionLabel()">What you'd be trusting</div>

                <template v-if="listing.entry.securityReview">
                    <div class="flex items-start gap-2 text-xs">
                        <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                        <span class="text-content">
                            <b>Deterministic scan</b>: {{ listing.entry.securityReview.deterministic.scanner }}
                            {{ listing.entry.securityReview.deterministic.version }} found no blocking dependency, secret, or configuration issue.
                            <span class="text-muted">Workflow run {{ listing.entry.securityReview.deterministic.runId }}.</span>
                        </span>
                    </div>
                    <div class="flex items-start gap-2 text-xs">
                        <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                        <span class="text-content">
                            <b>Agent security audit</b>: {{ listing.entry.securityReview.reviewer }} passed this exact source under
                            <code class="ui-code">{{ listing.entry.securityReview.policy }}</code
                            >. <span class="text-muted">Gate run {{ listing.entry.securityReview.runId }}.</span>
                        </span>
                    </div>
                </template>
                <div v-else class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content">
                        <b>No security audit record</b>: this registry has not bound both automated checks to the source.
                    </span>
                </div>

                <div v-if="verified" class="flex items-start gap-2 text-xs">
                    <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>Human reviewed</b>: someone here also read the source at this commit.
                        <span v-if="listing.entry.trustReason" class="text-muted">{{ listing.entry.trustReason }}</span>
                    </span>
                </div>
                <div v-else class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content"><b>No human source review</b>: use your own agent read if you want an independent account.</span>
                </div>

                <div v-if="ref40" class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>Pinned</b>: you install commit <code class="ui-code">{{ shortRef }}</code
                        >. <span class="text-muted">A force-push upstream cannot change what runs here.</span>
                    </span>
                </div>

                <div class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content">
                        <b>Not browser-isolated</b>:
                        <span class="text-muted">
                            its bundle shares this app's page, browser storage and network access. The manifest gates daemon calls made through the
                            extension API; it does not confine browser code.
                        </span>
                    </span>
                </div>

                <!-- Evidence, not endorsement, and silent when there's none: a registry with no scanner hasn't failed a check. -->
                <div v-if="loads" class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-muted">Re-checked at this exact commit by the registry's nightly scan: the manifest parses and it loads.</span>
                </div>
                <div v-else-if="problem" class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-muted">{{ problem }}</span>
                </div>
            </div>

            <div v-if="sourceHref" class="flex flex-wrap items-baseline gap-x-2 text-2xs">
                <span class="text-subtle">Source</span>
                <a
                    :href="sourceHref"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="inline-flex items-center gap-1 font-mono text-link hover:underline"
                >
                    {{ repo ?? listing.entry.install?.url }}<span v-if="shortRef"> @ {{ shortRef }}</span> <Icon name="external-link" />
                </a>
            </div>
            <p v-if="listing.entry.install?.path" class="text-2xs text-subtle">
                Lives in <code class="ui-code">{{ listing.entry.install.path }}</code> inside that repository.
            </p>

            <Notice v-if="failure" :of="failure" />
            <p v-if="listing.state.action !== undefined && !canInstall" class="text-2xs text-subtle">
                Only the sandbox owner can install extensions.
            </p>
        </div>

        <template #footer>
            <!-- Order follows what's been earned: where the code's been read, Install leads; where it hasn't, the read leads instead. -->
            <Button
                v-if="auditable"
                :label="auditLeads ? `Have my agent read the code first` : `Read the code first`"
                :severity="auditLeads ? undefined : `secondary`"
                :text="!auditLeads"
                size="small"
                @click="emit(`audit`)"
            >
                <template #icon><Icon name="sparkles" /></template>
            </Button>
            <Button
                v-if="actionable"
                :label="listing.state.action"
                size="small"
                :loading="installing"
                :severity="auditLeads ? `secondary` : undefined"
                @click="emit(`install`)"
            />
        </template>
    </Modal>
</template>
