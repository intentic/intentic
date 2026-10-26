<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { Button, formatCount, InfoHint, Notice, type NoticeTone, StatusBadge, ui } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import CatalogDetail from "../../../components/CatalogDetail.vue";
import { startAgent } from "../../../models/fleet/agentActions";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import { publishBrief, tightenBrief } from "../../../models/sandbox/extensionBrief";
import { devLineOf } from "./extensionDev";
import ExtensionFacts from "./ExtensionFacts.vue";
import ExtensionSection from "./ExtensionSection.vue";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";
import ExtensionUpdateOffer from "./ExtensionUpdateOffer.vue";
import ExtensionSwitch from "./ExtensionSwitch.vue";
import ExtensionUpdatePolicy from "./ExtensionUpdatePolicy.vue";
import { useT } from "@intentic/ui/i18n";

// One installed extension, opened where the Installed list stood, the way Capabilities opens a connection: the way back,
// then its mark, name and state with its switch at the head, since on and off is the verb for the whole of it. Below,
// it reads top to bottom by how soon the reader has to act: what is wrong or waiting (alerts, the update on offer), what
// they set (settings, update policy), what it may reach, and last, apart, removing it. What it is (version, source,
// what it adds) is ExtensionFacts, docked beside all that on a wide pane and at the foot on a narrow one.

const t = useT();

const { entry, pending } = defineProps<{ entry: ExtensionEntry; pending: boolean }>();

// Each verb names the extension it acts on, so the list that owns the verbs needs no handle on which page is open.
const emit = defineEmits<{
    toggle: [extension: ExtensionSummary, enabled: boolean];
    remove: [extension: ExtensionSummary];
    devClear: [extension: ExtensionSummary];
    back: [];
}>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);
const installed = computed(() => entry.extension.source === `installed`);

// Where it runs from when that is not its pinned copy (extensionDev.ts).
const dev = computed(() => entry.extension.dev);
const devLine = computed(() => devLineOf(entry.extension));

// The host's explanation in its own tone where it ranked one; anything it explained without ranking it is a fact.
const detailTone = computed<NoticeTone>(() => (entry.state.variant === `danger` || entry.state.variant === `warning` ? entry.state.variant : `info`));
// A registry advisory or an unhealthy update is the detail's source, and the update offer states both in full with what
// to do about them; the plain sentence would only say it twice.
const registryAlert = computed(() => installed.value && (entry.extension.advisory !== undefined || entry.extension.health?.state === `unhealthy`));
const detailNotice = computed(() => (registryAlert.value ? undefined : entry.detail));

// The update offer's own id, which its card reads.
const updateAnchor = computed(() => `extension-update-${entry.extension.id}`);

// Offered only where removal means something: a baked extension has no files here to delete, and an essential one is
// the control surface for work that carries on regardless. Both refuse daemon-side too; this is what stops the button
// being an invitation to be told no.
const removable = computed(() => entry.extension.source !== `builtin` && entry.extension.essential !== true);
// The one consequence worth naming beside the button, because it is the one nobody expects: connections the owner
// configured themselves go too. The dialog spells out the rest.
const removalHint = computed(() =>
    entry.dependents.length === 0
        ? t(`sandbox.extensionRow.removalHintNone`)
        : t(`sandbox.extensionRow.removalHintConnections`, { count: entry.dependents.length }, entry.dependents.length),
);

// What the extension has actually done with its declared reach, from a per-route call ledger. With no observations yet
// (just installed, or never opened), every route reads as declared rather than guessed 'unneeded'. The method is split
// off so the eye reads the path, which is the part that says what it touches.
const observed = computed(() => entry.extension.usage);
const routes = computed(() =>
    (manifest.value.permissions?.sandbox ?? []).map((route) => {
        const calls = observed.value?.[route]?.calls ?? 0;
        const space = route.indexOf(` `);
        return {
            route,
            method: space === -1 ? `` : route.slice(0, space),
            path: space === -1 ? route : route.slice(space + 1),
            calls,
            unused: observed.value !== undefined && calls === 0,
        };
    }),
);
const usedCount = computed(() => routes.value.filter((route) => route.calls > 0).length);
const routesCaption = computed(() =>
    observed.value === undefined
        ? t(`sandbox.extensionRow.routesDeclared`, { count: routes.value.length }, routes.value.length)
        : t(`sandbox.extensionRow.routesUsed`, { used: usedCount.value, count: routes.value.length }, routes.value.length),
);

// Only for a workspace extension, whose manifest the owner can actually edit; needs at least one route used and one
// never called, so there's something to act on.
const tightenable = computed(
    () =>
        entry.extension.source === `workspace` &&
        observed.value !== undefined &&
        routes.value.some((route) => route.unused) &&
        routes.value.some((route) => route.calls > 0),
);

// Fetched when the page opens, since it reads the bundle off disk. Shown for a workspace extension only: the same
// checks against an installed one would flag somebody else's commit the owner can't change.
const readiness = ref<{ id: string; label: string; status: string; detail: string }[]>();
const readinessError = ref<string>();
onMounted(async () => {
    if (entry.extension.source !== `workspace`) {
        return;
    }
    readinessError.value = undefined;
    try {
        const result = await sandboxRpc.extensions.readiness({ id: entry.extension.id });
        readiness.value = [...result.checks];
    } catch (failure) {
        readiness.value = undefined;
        readinessError.value = messageOr(failure, t(`sandbox.extensionRow.couldNotCheck`));
    }
});

// All checks ran and none failed; a warning stays the author's call, not a blocker.
const publishable = computed(() => readiness.value !== undefined && !readiness.value.some((check) => check.status === `fail`));
// A workspace extension's name is its directory (one per subdirectory), so no round trip is needed.
const workspaceDir = computed(() => `.intentic/config/workspace-extensions/${manifest.value.name}`);
const publish = computed(() => ({ id: extensionIdOf(manifest.value), dir: workspaceDir.value, name: manifest.value.name }));
const tighten = computed(() => ({
    id: extensionIdOf(manifest.value),
    dir: workspaceDir.value,
    unused: routes.value.filter((route) => route.unused).map((route) => route.route),
    used: routes.value.filter((route) => route.calls > 0).map(({ route, calls }) => ({ route, calls })),
}));

// Where it shows up, ordered by facetsOf's visibility ranking: the heading's one line of what it is. Settings are not a
// place, and the page lists them right below.
const places = computed(() =>
    entry.facets
        .filter((facet) => facet.surface && facet.kind !== `settings`)
        .map((facet) => facet.label)
        .join(` · `),
);
</script>

<template>
    <CatalogDetail
        :back="t(`sandbox.words.installed`)"
        :name="manifest.name"
        :prefix="entry.extension.source === `builtin` ? undefined : manifest.publisher"
        :description="places || undefined"
        :art="manifest.art"
        :logo="manifest.logo"
        :icon="manifest.icon"
        :idle="!entry.extension.enabled"
        @back="emit(`back`)"
    >
        <template v-if="entry.state.badge || entry.extension.update !== undefined" #badge>
            <StatusBadge v-if="entry.state.badge" size="xs" :dot="true" :variant="entry.state.variant" :label="entry.state.label" />
            <StatusBadge
                v-else-if="entry.extension.update !== undefined"
                size="xs"
                :variant="entry.extension.update.securityFix ? `danger` : `info`"
                :label="entry.extension.update.securityFix ? t(`sandbox.extensionRow.securityUpdate`) : t(`sandbox.extensionRow.update`)"
            />
        </template>
        <template #actions>
            <ExtensionSwitch :extension="entry.extension" :pending="pending" @toggle="(enabled) => emit(`toggle`, entry.extension, enabled)" />
        </template>

        <div class="flex flex-col gap-2.5">
            <!-- What is wrong or waiting leads, each in a box of its own tone; an ordinary extension has none of them. -->
            <Notice v-if="detailNotice" :tone="detailTone" size="sm">{{ detailNotice }}</Notice>

            <!-- Where it runs from, and the way back; the checkout itself is never touched from here. -->
            <Notice v-if="devLine !== undefined" :tone="dev?.held === undefined ? `info` : `warning`" size="sm">
                {{ devLine }}
                <template #actions>
                    <Button
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.extensionRow.devBackToPinned`)"
                        :disabled="pending"
                        @click="emit(`devClear`, entry.extension)"
                    >
                        <template #icon><Icon name="undo" /></template>
                    </Button>
                </template>
            </Notice>

            <ExtensionUpdateOffer v-if="installed" :extension="entry.extension" :anchor="updateAnchor" />

            <!-- The record proper: one section per question, ruled apart, each headed the same way. -->
            <div>
                <div class="divide-y divide-line">
                    <ExtensionSection v-if="settings.length > 0" :label="t(`shared.settings`)">
                        <ExtensionSettingsForm :extension-id="entry.extension.id" :settings="settings" />
                    </ExtensionSection>

                    <!-- Only git-installed extensions have an update lifecycle to set a policy for. -->
                    <ExtensionUpdatePolicy v-if="installed" :extension="entry.extension" />

                    <!-- The reach approved at install, and whether it was ever used. -->
                    <ExtensionSection v-if="routes.length > 0" :label="t(`sandbox.extensionRow.sandboxAccess`)" :caption="routesCaption">
                        <div class="flex flex-col gap-2">
                            <ul class="flex flex-wrap gap-1.5" :aria-label="t(`sandbox.extensionRow.sandboxAccess`)">
                                <li
                                    v-for="route in routes"
                                    :key="route.route"
                                    v-tooltip.top="
                                        route.calls > 0
                                            ? {
                                                  title: t(`sandbox.extensionRow.used`),
                                                  rows: [{ label: t(`sandbox.extensionRow.calls`), value: formatCount(route.calls) }],
                                              }
                                            : route.unused
                                              ? t(`sandbox.extensionRow.neverCalled`)
                                              : undefined
                                    "
                                    class="flex items-baseline gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-2xs"
                                    :class="route.unused ? `border-dashed border-line-strong text-subtle` : `border-line bg-canvas/60 text-content`"
                                >
                                    <span class="text-[0.625rem] font-medium" :class="route.unused ? `` : `text-muted`">{{ route.method }}</span>
                                    <span>{{ route.path }}</span>
                                </li>
                            </ul>
                            <!-- A legend, not a lecture: the reasoning behind "never called" waits behind its (i). -->
                            <div v-if="observed === undefined" class="text-2xs text-subtle">{{ t(`sandbox.extensionRow.notObservedYet`) }}</div>
                            <div
                                v-else-if="routes.some((route) => route.unused)"
                                class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle"
                            >
                                <span class="flex items-center gap-1.5">
                                    <span class="inline-block h-2.5 w-4 rounded-sm border border-dashed border-line-strong" aria-hidden="true" />
                                    {{ t(`sandbox.extensionRow.neverCalled`) }}
                                    <InfoHint :label="t(`sandbox.extensionRow.neverCalledWhyLabel`)">
                                        <span class="block text-xs text-content">{{ t(`sandbox.extensionRow.neverCalledWhy`) }}</span>
                                    </InfoHint>
                                </span>
                                <!-- Maintainer-owned extensions route review to the owner. -->
                                <button
                                    v-if="tightenable"
                                    type="button"
                                    :class="ui.textButton({ size: `xs` })"
                                    @click="startAgent(tightenBrief(tighten))"
                                >
                                    {{ t(`sandbox.extensionRow.agentGoThrough`) }}
                                </button>
                            </div>
                        </div>
                    </ExtensionSection>

                    <!-- File checks cover only facts answerable without running the extension. -->
                    <ExtensionSection
                        v-if="entry.extension.source === `workspace`"
                        :label="t(`sandbox.extensionRow.publishing`)"
                        :caption="t(`sandbox.extensionRow.publishingCaption`)"
                    >
                        <div class="flex flex-col gap-2.5">
                            <p v-if="readinessError" class="text-2xs text-danger">{{ readinessError }}</p>
                            <ul v-else-if="readiness" class="flex flex-col gap-1">
                                <li v-for="check in readiness" :key="check.id" class="flex items-start gap-1.5 text-2xs">
                                    <Icon
                                        :name="check.status === `pass` ? `check` : check.status === `warn` ? `exclamation-triangle` : `times`"
                                        :class="check.status === `pass` ? `text-success` : check.status === `warn` ? `text-warning` : `text-danger`"
                                        class="shrink-0"
                                    />
                                    <span class="text-content"
                                        >{{ check.label }} <span class="text-subtle">· {{ check.detail }}</span></span
                                    >
                                </li>
                            </ul>
                            <!-- Offered only when nothing fails; a warning is the author's call, not a blocker. -->
                            <div v-if="publishable" class="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                                <Button
                                    size="small"
                                    tier="boring"
                                    :label="t(`sandbox.extensionRow.publishWithAgent`)"
                                    @click="startAgent(publishBrief(publish))"
                                >
                                    <template #icon><Icon name="sparkles" /></template>
                                </Button>
                                <span class="text-2xs text-subtle">{{ t(`sandbox.extensionRow.publishAgentPushesFiles`) }}</span>
                            </div>
                        </div>
                    </ExtensionSection>
                </div>

                <!-- What it is: docked beside the page on a wide pane, read here at the foot on a narrow one. Outside the
                 ruled list above, whose rules would otherwise count the hidden copy as a part and draw a line before it. -->
                <ExtensionFacts :entry="entry" class="border-t border-line py-5 @3xl:hidden" />

                <!-- Apart and last: uninstalling is not the errand this page is opened for. A real, bordered button, since it
                 is the one thing here nothing undoes; the dialog it raises spells out the consequences. -->
                <footer v-if="removable" class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line py-3.5">
                    <div class="min-w-0">
                        <p class="text-xs font-medium text-content">{{ t(`sandbox.extensionRow.removeTitle`) }}</p>
                        <p class="mt-0.5 text-2xs text-subtle">{{ removalHint }}</p>
                    </div>
                    <Button size="small" tone="danger" :label="t(`sandbox.extensionRow.remove`)" @click="emit(`remove`, entry.extension)">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </footer>
            </div>
        </div>

        <!-- Pushed down by the way back and the heading (102px) and a section's top padding, so its header lines up with
             the first section's rather than with the extension's name. -->
        <template #aside>
            <ExtensionFacts :entry="entry" class="pt-[7.625rem]" />
        </template>
    </CatalogDetail>
</template>
