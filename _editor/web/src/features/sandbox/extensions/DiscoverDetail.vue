<script setup lang="ts">
import { githubRepoOf, isCurrentSecurityReview } from "@intentic/registry";
import { BrandMark, Button, ui, Modal, Notice, type NoticeModel } from "@intentic/ui";
import { computed, ref, useId } from "vue";
import { checksOk, checksProblem, type DiscoverListing, splitListingName } from "./discoverListing";
import { useT } from "@intentic/ui/i18n";

// One listing, read before it's run: where this product's trust argument gets made explicit rather than implied. Source
// identity, scanner, agent gate and human review are separate guarantees shown as separate lines, not one badge. The
// owner's own agent read is offered as primary where no human has reviewed the code, secondary otherwise. An unaudited
// commit installs only after the owner ticks that they know nobody checked it.

const t = useT();

const { listing, canInstall, installing } = defineProps<{
    listing: DiscoverListing;
    /** Installing is the owner's alone; everyone else browses. */
    canInstall: boolean;
    installing: boolean;
    failure?: NoticeModel | undefined;
}>();

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ install: []; audit: [] }>();

// The brand row replaces the modal's own title, so the name it is announced by has to be pointed at this one.
const titleId = useId();

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

// Whether the registry's audit record covers this exact commit under the current policy; an older one is no cover.
const auditCurrent = computed(() => isCurrentSecurityReview(listing.entry.securityReview, listing.entry.install));
const unaudited = computed(() => listing.state.unaudited === true);
const acknowledged = ref(false);
const actionLabel = computed(() => {
    if (!unaudited.value) {
        return listing.state.action;
    }
    return listing.state.kind === `update` ? t(`sandbox.discoverDetail.updateAnyway`) : t(`sandbox.discoverDetail.installAnyway`);
});
</script>

<template>
    <!-- The footer wraps so the primary action remains usable on phones. -->
    <Modal v-model:open="open" size="md" :labelled-by="titleId">
        <template #header>
            <div class="flex min-w-0 items-center gap-3">
                <BrandMark :size="32" :name="listing.entry.name" :art="listing.entry.art" :logo="listing.entry.logo" :icon="listing.entry.icon" />
                <div class="min-w-0">
                    <div :id="titleId" class="truncate font-medium text-content">{{ name.title }}</div>
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
                    {{ t(`sandbox.discoverDetail.homepage`) }} <Icon name="external-link" />
                </a>
            </div>

            <!-- A non-default state is said before anything else, so a reader never has to reach the button to learn it. -->
            <Notice v-if="listing.state.kind === `blocked`" tone="danger">
                <b>{{ t(`sandbox.discoverDetail.blocked`) }}</b> {{ listing.state.reason }} {{ t(`sandbox.discoverDetail.staysListedRatherThan`) }}
            </Notice>
            <Notice v-else-if="listing.state.kind === `unavailable`" tone="info">{{ listing.state.reason }}</Notice>
            <Notice v-else-if="unaudited" tone="warning">
                <b>{{ t(`sandbox.discoverDetail.notSecurityAudited`) }}</b> {{ t(`sandbox.discoverDetail.exactCommitNotPassed`) }}
                {{ t(`sandbox.discoverDetail.canStillInstall`) }}
            </Notice>
            <Notice v-else-if="listing.state.kind === `installed`" tone="info">
                {{ t(`sandbox.discoverDetail.alreadyInstalledInSandbox`) }}
            </Notice>
            <Notice v-if="listing.state.kind === `update`" tone="info">
                {{ t(`sandbox.discoverDetail.installedAt`) }} <code class="ui-code">{{ listing.state.installedRef?.slice(0, 10) }}</code
                >. The listing points at <code class="ui-code">{{ shortRef }}</code
                >. Updating replaces the code wholesale and re-asks for broader declared host API access; code internals still need review.
            </Notice>

            <!-- Keep the three guarantees separate and ordered by responsibility. -->
            <div class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
                <div :class="ui.sectionLabel()">{{ t(`sandbox.discoverDetail.whatYoudTrusting`) }}</div>

                <template v-if="listing.entry.securityReview && auditCurrent">
                    <div class="flex items-start gap-2 text-xs">
                        <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                        <span class="text-content">
                            <b>{{ t(`sandbox.discoverDetail.deterministicScan`) }}</b
                            >: {{ listing.entry.securityReview.deterministic.scanner }} {{ listing.entry.securityReview.deterministic.version }}
                            {{ t(`sandbox.discoverDetail.foundNoBlockingDependency`) }}
                            <span class="text-muted">{{
                                t(`sandbox.discoverDetail.workflowRun`, { runId: listing.entry.securityReview.deterministic.runId })
                            }}</span>
                        </span>
                    </div>
                    <div class="flex items-start gap-2 text-xs">
                        <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                        <span class="text-content">
                            <b>{{ t(`sandbox.discoverDetail.agentSecurityAudit`) }}</b
                            >: {{ listing.entry.securityReview.reviewer }} {{ t(`sandbox.discoverDetail.passedExactSourceUnder`) }}
                            <code class="ui-code">{{ listing.entry.securityReview.policy }}</code
                            >.
                            <span class="text-muted">{{ t(`sandbox.discoverDetail.gateRun`, { runId: listing.entry.securityReview.runId }) }}</span>
                        </span>
                    </div>
                </template>
                <div v-else-if="listing.entry.securityReview" class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content">
                        <b>{{ t(`sandbox.discoverDetail.securityAuditOutOfDate`) }}</b
                        >{{ t(`sandbox.discoverDetail.auditRecordDoesntCover`) }}
                    </span>
                </div>
                <div v-else class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content">
                        <b>{{ t(`sandbox.discoverDetail.noSecurityAuditRecord`) }}</b
                        >{{ t(`sandbox.discoverDetail.registryNotBoundBoth`) }}
                    </span>
                </div>

                <div v-if="verified" class="flex items-start gap-2 text-xs">
                    <Icon name="shield" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>{{ t(`sandbox.discoverDetail.humanReviewed`) }}</b
                        >{{ t(`sandbox.discoverDetail.someoneHereAlsoRead`) }}
                        <span v-if="listing.entry.trustReason" class="text-muted">{{ listing.entry.trustReason }}</span>
                    </span>
                </div>
                <div v-else class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content"
                        ><b>{{ t(`sandbox.discoverDetail.noHumanSourceReview`) }}</b
                        >{{ t(`sandbox.discoverDetail.useOwnAgentRead`) }}</span
                    >
                </div>

                <div v-if="ref40" class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-content">
                        <b>{{ t(`sandbox.discoverDetail.pinned`) }}</b
                        >{{ t(`sandbox.discoverDetail.installCommit`) }} <code class="ui-code">{{ shortRef }}</code
                        >. <span class="text-muted">{{ t(`sandbox.discoverDetail.forcePushUpstreamCannot`) }}</span>
                    </span>
                </div>

                <div class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-content">
                        <b>{{ t(`sandbox.discoverDetail.notBrowserIsolated`) }}</b
                        >:
                        <span class="text-muted">
                            {{ t(`sandbox.discoverDetail.bundleSharesAppsPage`) }}
                        </span>
                    </span>
                </div>

                <!-- Evidence, not endorsement, and silent when there's none: a registry with no scanner hasn't failed a check. -->
                <div v-if="loads" class="flex items-start gap-2 text-xs">
                    <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                    <span class="text-muted">{{ t(`sandbox.discoverDetail.reCheckedAtExact`) }}</span>
                </div>
                <div v-else-if="problem" class="flex items-start gap-2 text-xs">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" />
                    <span class="text-muted">{{ problem }}</span>
                </div>
            </div>

            <div v-if="sourceHref" class="flex flex-wrap items-baseline gap-x-2 text-2xs">
                <span class="text-subtle">{{ t(`shared.source`) }}</span>
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
                {{ t(`sandbox.discoverDetail.livesIn`) }} <code class="ui-code">{{ listing.entry.install.path }}</code>
                {{ t(`sandbox.discoverDetail.insideRepository`) }}
            </p>

            <!-- The explicit yes an unaudited install waits on, stated as what the reader is accepting. -->
            <label v-if="unaudited && actionable" class="flex cursor-pointer items-start gap-2 text-xs text-content">
                <input v-model="acknowledged" type="checkbox" class="mt-0.5 shrink-0 accent-primary-600" />
                <span>{{ t(`sandbox.discoverDetail.understandNobodyAudited`) }}</span>
            </label>

            <Notice v-if="failure" :of="failure" />
            <p v-if="listing.state.action !== undefined && !canInstall" class="text-2xs text-subtle">
                {{ t(`sandbox.discoverDetail.onlySandboxOwnerInstall`) }}
            </p>
        </div>

        <template #footer>
            <!-- Order follows what's been earned: where the code's been read, Install leads; where it hasn't, the read leads instead. -->
            <Button
                v-if="auditable"
                :label="auditLeads ? t(`sandbox.discoverDetail.myAgentReadCode`) : t(`sandbox.discoverDetail.readCodeFirst`)"
                :severity="auditLeads ? undefined : `secondary`"
                :text="!auditLeads"
                size="small"
                @click="emit(`audit`)"
            >
                <template #icon><Icon name="sparkles" /></template>
            </Button>
            <Button
                v-if="actionable"
                :label="actionLabel"
                size="small"
                :loading="installing"
                :disabled="unaudited && !acknowledged"
                :severity="auditLeads ? `secondary` : undefined"
                @click="emit(`install`)"
            />
        </template>
    </Modal>
</template>
