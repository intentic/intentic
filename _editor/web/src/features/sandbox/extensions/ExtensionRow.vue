<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { BrandMark, Button, DisclosureRow, formatCount, InfoHint, Notice, type NoticeTone, StatusBadge, ui } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, ref, watch } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import { publishBrief, tightenBrief } from "./extensionBrief";
import ExtensionSection from "./ExtensionSection.vue";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";
import ExtensionUpdateOffer from "./ExtensionUpdateOffer.vue";
import ExtensionUpdatePolicy from "./ExtensionUpdatePolicy.vue";
import { useT } from "@intentic/ui/i18n";

// One extension, one line until expanded: name, its places, then the switch. Open, it reads top to bottom by how soon
// the reader has to act: what is wrong or waiting (alerts, the update on offer), what they set (settings, update policy),
// what it may reach, what it is (one table of the facts nobody opens a row for), and last, apart, removing it. Tier and
// mark size come from the list's own RowGroup density, not this file.

const t = useT();

const { entry, expanded, pending } = defineProps<{ entry: ExtensionEntry; expanded: boolean; pending: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; remove: []; devClear: []; "update:expanded": [expanded: boolean] }>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);
const installed = computed(() => entry.extension.source === `installed`);

// An install running from a source checkout instead of its pinned copy (dev mode), or pointed at one that is held. Said
// on the closed row too: what runs is not what the commit below names, and that is the first thing to know about it.
const dev = computed(() => entry.extension.dev);
const devLine = computed(() => {
    const current = dev.value;
    if (current === undefined) {
        return undefined;
    }
    const where =
        current.conversation === undefined
            ? current.path
            : t(`sandbox.extensionRow.devInConversation`, { path: current.path, conversation: current.conversation });
    if (current.held !== undefined) {
        return t(`sandbox.extensionRow.devHeld`, { where, reason: current.held });
    }
    const running = t(`sandbox.extensionRow.devRunningFrom`, { where });
    const count = current.uncommitted ?? 0;
    return count === 0 ? running : `${running} · ${t(`sandbox.extensionRow.devUncommitted`, { count }, count)}`;
});

// Muted by default: anything the host explained without ranking as an exception is a fact, not an alarm.
const TONE: Record<string, string> = { danger: `text-danger`, warning: `text-warning` };
const tone = computed(() => TONE[entry.state.variant] ?? `text-muted`);
const NOTICE: Record<string, NoticeTone> = { danger: `danger`, warning: `warning` };
const detailTone = computed<NoticeTone>(() => NOTICE[entry.state.variant] ?? `info`);
// A registry advisory or an unhealthy update is the detail's source, and the update offer states both in full with what
// to do about them; the plain sentence would only say it twice.
const registryAlert = computed(() => installed.value && (entry.extension.advisory !== undefined || entry.extension.health?.state === `unhealthy`));
const detailNotice = computed(() => (registryAlert.value ? undefined : entry.detail));

// The pill and the drawer's lead are one idea: pressing `update` opens the row onto the offer, focused, rather than
// being a label the reader has to go looking behind.
const updateAnchor = computed(() => `extension-update-${entry.extension.id}`);
const showUpdate = async (): Promise<void> => {
    if (!expanded) {
        emit(`update:expanded`, true);
    }
    await nextTick();
    const offer = document.getElementById(updateAnchor.value);
    offer?.scrollIntoView({ block: `nearest`, behavior: `smooth` });
    offer?.querySelector<HTMLButtonElement>(`button`)?.focus({ preventScroll: true });
};

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

// Fetched only when the row opens, since it reads the bundle off disk. Shown for a workspace extension only: the same
// checks against an installed one would flag somebody else's commit the owner can't change.
const readiness = ref<{ id: string; label: string; status: string; detail: string }[]>();
const readinessError = ref<string>();
watch(
    () => [expanded, entry.extension.id] as const,
    async ([open]) => {
        if (!open || entry.extension.source !== `workspace`) {
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
    },
    { immediate: true },
);

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

// How many places fit on a line before the column starts eating words rather than items.
const PLACES_SHOWN = 3;
// Ordered by facetsOf's visibility ranking.
const places = computed(() => entry.facets.filter((facet) => facet.surface).map((facet) => facet.label));
const shown = computed(() => places.value.slice(0, PLACES_SHOWN).join(` · `));
const hidden = computed(() => places.value.slice(PLACES_SHOWN));
// The Details table names what it adds; settings are left out, since the Settings section above renders them better.
const contributes = computed(() => entry.facets.filter((facet) => facet.kind !== `settings`));

// What flipping the switch doesn't reach immediately; stated under the fold, before the flip, rather than on every
// closed row.
const deferredNote = (kind: string): string[] => {
    switch (kind) {
        case `agent`:
            return [t(`sandbox.extensionRow.deferredAgent`)];
        case `bin`:
            return [t(`sandbox.extensionRow.deferredBin`)];
        case `environment`:
            return [t(`sandbox.extensionRow.deferredEnvironment`)];
        default:
            return [];
    }
};

const consequences = computed<string[]>(() => {
    const deferred = Object.keys(manifest.value.contributes ?? {}).flatMap(deferredNote);
    if (entry.dependents.length === 0) {
        return deferred;
    }
    const named = entry.dependents.map((capability) => capability.id).join(`, `);
    const count = entry.dependents.length;
    // Switching off only hides their card; removing takes the entries themselves, which is the dialog's job to say.
    return [...deferred, t(`sandbox.extensionRow.dependentsLoseCard`, { count, names: named }, count)];
});

// Where the running code comes from, in words, with the one identifier that pins it down beside them.
const source = computed<{ words: string; mark?: string }>(() => {
    if (entry.extension.source === `builtin`) {
        return { words: t(`sandbox.extensionRow.sourceBuiltin`) };
    }
    if (entry.extension.source === `workspace`) {
        return { words: t(`sandbox.extensionRow.sourceWorkspace`), mark: workspaceDir.value };
    }
    return { words: t(`sandbox.extensionRow.sourceInstalled`), mark: entry.extension.commit.slice(0, 12) };
});
</script>

<template>
    <!-- Open extensions share one tinted header and detail block. A row that needs attention says so with its badge, its
         tinted detail and the section pinned above the rest, not with an edge stripe as well. -->
    <DisclosureRow class="@container" body="drawer" :open="expanded" @update:open="emit(`update:expanded`, !expanded)">
        <template #lead="{ mark }">
            <!-- Dimmed and desaturated when off, so the mark goes quiet with the rest of the row. -->
            <BrandMark
                :size="mark"
                :name="manifest.name"
                :art="manifest.art"
                :logo="manifest.logo"
                :icon="manifest.icon"
                :idle="!entry.extension.enabled"
            />
        </template>

        <template #title>
            <span class="flex min-w-0 items-baseline gap-3">
                <!-- Dimming never touches the switch, the one control that still does something on an off row. -->
                <span class="min-w-0 flex-1 truncate font-normal @2xl:w-48 @2xl:flex-none">
                    <span v-if="entry.extension.source !== `builtin`" class="text-subtle">{{ manifest.publisher }}.</span
                    ><span class="font-medium" :class="entry.extension.enabled ? `text-content` : `text-muted`">{{ manifest.name }}</span>
                </span>
                <span
                    class="hidden min-w-0 flex-1 items-baseline gap-1.5 text-xs font-normal @2xl:flex"
                    :class="entry.extension.enabled ? `text-muted` : `text-subtle`"
                >
                    <span v-tooltip.overflow="shown" class="min-w-0 truncate">{{ shown }}</span>
                    <span v-if="hidden.length > 0" v-tooltip.top="hidden.join(` · `)" class="shrink-0 text-subtle">+{{ hidden.length }}</span>
                </span>
            </span>
        </template>

        <!-- Shown only while closed: once open, the drawer states it in full, and a truncated copy would be noise. -->
        <template v-if="(entry.detail || devLine) && !expanded" #description>
            <span v-if="entry.detail" class="block truncate" :class="tone">{{ entry.detail }}</span>
            <span v-else class="block truncate" :class="dev?.held === undefined ? `text-muted` : `text-warning`">{{ devLine }}</span>
        </template>

        <template #control>
            <div class="flex shrink-0 items-center gap-2.5">
                <!-- A way in, not a label: it opens the row onto the offer. Security updates use the loud tier; ordinary
                     ones stay ambient. -->
                <button
                    v-if="!entry.state.attention && entry.extension.update !== undefined"
                    v-tooltip.top="t(`sandbox.extensionRow.reviewUpdate`)"
                    type="button"
                    class="cursor-pointer rounded-full transition-[filter] hover:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-500"
                    @click="showUpdate"
                >
                    <StatusBadge
                        :variant="entry.extension.update.securityFix ? `danger` : `info`"
                        :label="entry.extension.update.securityFix ? t(`sandbox.extensionRow.securityUpdate`) : t(`sandbox.extensionRow.update`)"
                        size="xs"
                    />
                </button>
                <StatusBadge v-if="entry.state.badge" :variant="entry.state.variant" :label="entry.state.label" size="xs" />
                <span v-else-if="entry.state.label !== undefined" class="text-2xs text-subtle">{{ entry.state.label }}</span>
                <!-- Fixed, not hidden: a vanished control reads as a bug. -->
                <span
                    v-if="entry.extension.essential"
                    v-tooltip.top="{ title: t(`sandbox.extensionRow.alwaysOnTitle`), note: t(`sandbox.extensionRow.showsBackgroundWork`) }"
                    class="cursor-not-allowed"
                >
                    <ToggleSwitch
                        class="ui-switch-sm pointer-events-none"
                        :model-value="true"
                        disabled
                        :aria-label="t(`sandbox.extensionRow.alwaysOn`, { manifest: extensionIdOf(manifest) })"
                    />
                </span>
                <ToggleSwitch
                    v-else
                    class="ui-switch-sm"
                    :model-value="entry.extension.enabled"
                    :disabled="pending"
                    :aria-label="t(`sandbox.extensionRow.enable`, { manifest: extensionIdOf(manifest) })"
                    @update:model-value="(value: boolean) => emit(`toggle`, value)"
                />
            </div>
        </template>

        <template #below>
            <div class="flex flex-col gap-2.5 pt-2">
                <!-- What is wrong or waiting leads, each in a box of its own tone; the ordinary row has none of them. -->
                <Notice v-if="detailNotice" :tone="detailTone" size="sm">{{ detailNotice }}</Notice>

                <!-- Where it runs from, and the way back; the checkout itself is never touched from here. -->
                <Notice v-if="devLine !== undefined" :tone="dev?.held === undefined ? `info` : `warning`" size="sm">
                    {{ devLine }}
                    <template #actions>
                        <Button
                            size="small"
                            severity="secondary"
                            :label="t(`sandbox.extensionRow.devBackToPinned`)"
                            :disabled="pending"
                            @click="emit(`devClear`)"
                        >
                            <template #icon><Icon name="undo" /></template>
                        </Button>
                    </template>
                </Notice>

                <ExtensionUpdateOffer v-if="installed" :extension="entry.extension" :anchor="updateAnchor" />

                <!-- The record proper: one section per question, ruled apart, each named in the same left column. -->
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
                                    :class="ui.linkButton(`text-2xs`)"
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
                                <li v-for="check in readiness" :key="check.id" class="flex gap-1.5 text-2xs">
                                    <Icon
                                        :name="check.status === `pass` ? `check` : check.status === `warn` ? `exclamation-triangle` : `times`"
                                        :class="check.status === `pass` ? `text-success` : check.status === `warn` ? `text-warning` : `text-danger`"
                                        class="mt-0.5 shrink-0"
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
                                    severity="secondary"
                                    :label="t(`sandbox.extensionRow.publishWithAgent`)"
                                    @click="startAgent(publishBrief(publish))"
                                >
                                    <template #icon><Icon name="sparkles" /></template>
                                </Button>
                                <span class="text-2xs text-subtle">{{ t(`sandbox.extensionRow.publishAgentPushesFiles`) }}</span>
                            </div>
                        </div>
                    </ExtensionSection>

                    <!-- Everything a collapsed row leaves off, as one table: read when needed, skipped otherwise. -->
                    <ExtensionSection :label="t(`sandbox.extensionRow.details`)">
                        <dl class="grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
                            <dt class="text-subtle">{{ t(`sandbox.extensionRow.detailId`) }}</dt>
                            <dd class="min-w-0 break-words font-mono text-2xs leading-5 text-content">{{ extensionIdOf(manifest) }}</dd>
                            <dt class="text-subtle">{{ t(`sandbox.extensionRow.detailVersion`) }}</dt>
                            <dd class="min-w-0 text-content">v{{ manifest.version }}</dd>
                            <dt class="text-subtle">{{ t(`sandbox.extensionRow.detailSource`) }}</dt>
                            <!-- The identifier wraps as one piece onto its own line rather than breaking mid-path. -->
                            <dd class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-content">
                                <span>{{ source.words }}</span>
                                <span v-if="source.mark" class="min-w-0 break-words font-mono text-2xs text-muted">{{ source.mark }}</span>
                            </dd>
                            <dt class="text-subtle">{{ t(`sandbox.extensionRow.detailRequires`) }}</dt>
                            <dd class="min-w-0 text-content">{{ t(`sandbox.extensionRow.requiresApp`, { range: manifest.engines.intentic }) }}</dd>
                            <template v-for="facet in contributes" :key="`${facet.kind}:${facet.label}`">
                                <dt class="text-subtle first-letter:uppercase">{{ facet.label }}</dt>
                                <dd class="min-w-0 break-words text-content">{{ facet.names.join(` · `) || `—` }}</dd>
                            </template>
                            <template v-if="entry.extension.enabled && consequences.length > 0">
                                <dt class="text-subtle">{{ t(`sandbox.extensionRow.whenSwitchedOff`) }}</dt>
                                <dd class="min-w-0">
                                    <ul class="flex flex-col gap-0.5 text-muted">
                                        <li v-for="consequence in consequences" :key="consequence" class="first-letter:uppercase">
                                            {{ consequence }}.
                                        </li>
                                    </ul>
                                </dd>
                            </template>
                        </dl>
                    </ExtensionSection>
                </div>

                <!-- Apart and last: uninstalling is not the errand a row is opened for. A real, bordered button, since it
                     is the one thing here nothing undoes; the dialog it raises spells out the consequences. -->
                <footer v-if="removable" class="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-line pt-3.5">
                    <div class="min-w-0">
                        <p class="text-xs font-medium text-content">{{ t(`sandbox.extensionRow.removeTitle`) }}</p>
                        <p class="mt-0.5 text-2xs text-subtle">{{ removalHint }}</p>
                    </div>
                    <Button size="small" severity="danger" :label="t(`sandbox.extensionRow.remove`)" @click="emit(`remove`)">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </footer>
            </div>
        </template>
    </DisclosureRow>
</template>
