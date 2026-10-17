<script setup lang="ts">
import { githubRepoOf, isCurrentSecurityReview } from "@intentic/registry";
import { ui } from "@intentic/ui";
import { computed } from "vue";
import { checksOk, checksProblem, type DiscoverListing } from "../../../models/sandbox/discoverListing";
import { useT } from "@intentic/ui/i18n";

// What installing a listing would trust, as separate guarantees on separate lines rather than one badge: source
// identity, the scanner, the agent gate and human review, ordered by who answers for each. Then where the code lives.
// The listing's page draws this twice: docked beside its actions on a wide pane, and inline before them on a narrow
// one, so the argument is always read before the button.

const t = useT();

const { listing } = defineProps<{ listing: DiscoverListing }>();

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
// Whether the registry's audit record covers this exact commit under the current policy; an older one is no cover.
const auditCurrent = computed(() => isCurrentSecurityReview(listing.entry.securityReview, listing.entry.install));
</script>

<template>
    <div class="flex flex-col gap-4">
        <!-- Keep the guarantees separate and ordered by responsibility. -->
        <section class="flex flex-col gap-2">
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
        </section>

        <div v-if="sourceHref" class="flex flex-col gap-1 text-2xs">
            <div class="flex flex-wrap items-baseline gap-x-2">
                <span class="text-subtle">{{ t(`sandbox.words.source`) }}</span>
                <a
                    :href="sourceHref"
                    target="_blank"
                    rel="noreferrer noopener"
                    class="inline-flex min-w-0 items-center gap-1 break-all font-mono text-link hover:underline"
                >
                    {{ repo ?? listing.entry.install?.url }}<span v-if="shortRef"> @ {{ shortRef }}</span> <Icon name="external-link" />
                </a>
            </div>
            <p v-if="listing.entry.install?.path" class="text-subtle">
                {{ t(`sandbox.discoverDetail.livesIn`) }} <code class="ui-code">{{ listing.entry.install.path }}</code>
                {{ t(`sandbox.discoverDetail.insideRepository`) }}
            </p>
        </div>
    </div>
</template>
