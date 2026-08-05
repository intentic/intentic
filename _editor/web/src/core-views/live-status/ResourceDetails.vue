<script setup lang="ts">
import type { Deployment, ResourceView } from "@intentic-app/api-contract";
import { Card, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import { computed, reactive } from "vue";
import { statusLabel, statusVariant } from "../../composables/extensions/reconcileStatus";
import { groupAccent, resourceIcon, resourceLogoUrl } from "../../composables/extensions/resourceVisual";

/* Details for the selected planned resource, shown below the dependency graph. Read-model only: everything is
 * already on the ResourceView (config, dependsOn, url, reason) or joined by id from the live deployments; the
 * dependency chips re-select through the shared `selectedId` model so the graph highlight moves with them. */

const { resource, resources, deployments } = defineProps<{
    resource: ResourceView;
    resources: readonly ResourceView[];
    deployments: readonly Deployment[];
}>();
// Same selection model as the graph — setting it re-selects (and re-highlights) a dependency.
const selectedId = defineModel<string | undefined>();

// The resources that list this one in their dependsOn — the reverse of the edges the graph draws.
const requiredBy = computed(() => resources.filter((r) => r.dependsOn.includes(resource.id)).map((r) => r.id));
const configEntries = computed(() => Object.entries(resource.config));
// The live Komodo deployment for this node, matched by name === id.
const deployment = computed(() => deployments.find((d) => d.name === resource.id));
// One public link, whether it came from the planned domain input or the live deployment.
const openUrl = computed(() => resource.url ?? deployment.value?.url);

// Cleared per resource id when its brand logo fails to load → fall back to the semantic glyph.
const logoFailed = reactive(new Set<string>());
</script>

<template>
    <Card class="mt-3 flex flex-col gap-3">
        <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 items-center gap-2.5">
                <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border" :class="groupAccent(resource.group).frame">
                    <img
                        v-if="resourceLogoUrl(resource.type) && !logoFailed.has(resource.id)"
                        :src="resourceLogoUrl(resource.type)"
                        :alt="resource.type"
                        class="h-5 w-5 shrink-0 object-contain"
                        @error="logoFailed.add(resource.id)"
                    />
                    <Icon v-else :name="resourceIcon(resource.type)" class="text-sm" />
                </span>
                <div class="flex min-w-0 flex-wrap items-center gap-2">
                    <span class="truncate font-medium text-content">{{ resource.id }}</span>
                    <StatusBadge :variant="statusVariant(resource.status)" :label="statusLabel(resource.status)" size="xs" dot />
                    <span class="inline-flex items-center rounded-full bg-subtle/10 px-1.5 py-0.5 text-2xs font-medium text-subtle">{{
                        resource.type
                    }}</span>
                    <span
                        class="inline-flex items-center rounded-full px-1.5 py-0.5 text-2xs font-medium"
                        :class="groupAccent(resource.group).frame"
                        >{{ resource.group }}</span
                    >
                </div>
            </div>
            <div class="flex shrink-0 items-center gap-2">
                <Button v-if="openUrl" as="a" label="Open" size="small" severity="secondary" :href="openUrl" target="_blank" rel="noopener">
                    <template #icon><Icon name="external-link" /></template>
                </Button>
                <Button
                    v-if="deployment?.komodoDeploymentUrl"
                    as="a"
                    label="Komodo"
                    size="small"
                    :text="true"
                    :href="deployment.komodoDeploymentUrl"
                    target="_blank"
                    rel="noopener"
                >
                    <template #icon><Icon name="cog" /></template>
                </Button>
                <Button size="small" :text="true" severity="secondary" aria-label="Close details" @click="selectedId = undefined">
                    <template #icon><Icon name="times" /></template>
                </Button>
            </div>
        </div>

        <!-- Why it's out of sync (present only for drift). -->
        <p v-if="resource.reason" class="text-sm text-muted"><span class="font-medium text-subtle">Reason:</span> {{ resource.reason }}</p>

        <!-- Resolved non-secret inputs — the "what does this resolve to" answer, shown nowhere else. -->
        <div v-if="configEntries.length > 0">
            <h4 class="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Config</h4>
            <div class="flex flex-wrap gap-1">
                <span v-for="[key, value] in configEntries" :key="key" class="rounded bg-overlay px-1.5 py-0.5 font-mono text-2xs text-subtle"
                    >{{ key }}={{ value }}</span
                >
            </div>
        </div>

        <!-- Both directions of the dependency edges, as chips that re-select to navigate the graph. -->
        <div v-if="resource.dependsOn.length > 0">
            <h4 class="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Depends on</h4>
            <div class="flex flex-wrap gap-1">
                <button
                    v-for="dep in resource.dependsOn"
                    :key="dep"
                    type="button"
                    class="rounded-full bg-subtle/10 px-2 py-0.5 font-mono text-2xs text-content transition-colors hover:bg-subtle/20"
                    @click="selectedId = dep"
                >
                    {{ dep }}
                </button>
            </div>
        </div>
        <div v-if="requiredBy.length > 0">
            <h4 class="mb-1 text-2xs font-semibold uppercase tracking-wide text-subtle">Required by</h4>
            <div class="flex flex-wrap gap-1">
                <button
                    v-for="dep in requiredBy"
                    :key="dep"
                    type="button"
                    class="rounded-full bg-subtle/10 px-2 py-0.5 font-mono text-2xs text-content transition-colors hover:bg-subtle/20"
                    @click="selectedId = dep"
                >
                    {{ dep }}
                </button>
            </div>
        </div>

        <!-- Live reality join: is the planned resource actually running, and on what image. -->
        <div v-if="deployment" class="border-t border-line pt-2">
            <div class="flex items-center gap-2">
                <h4 class="text-2xs font-semibold uppercase tracking-wide text-subtle">Running now</h4>
                <StatusBadge :variant="deployment.live ? 'success' : 'neutral'" :label="deployment.live ? 'Live' : 'Not deployed'" size="xs" dot />
            </div>
            <p class="mt-1 truncate font-mono text-2xs text-subtle">{{ deployment.image }}</p>
        </div>
    </Card>
</template>
