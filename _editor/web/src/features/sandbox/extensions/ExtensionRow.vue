<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { ExtensionReadinessSchema } from "@intentic/sandbox-contract";
import { BrandMark, DisclosureRow, ui, StatusBadge } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { startAgent } from "../../agents/fleet/agentActions";
import { sandboxJson } from "../client/sandboxClient";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import { publishBrief, tightenBrief } from "./extensionBrief";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";
import ExtensionUpdateCard from "./ExtensionUpdateCard.vue";

// One extension, one line until expanded: name, its places, then the switch; everything else moves below the fold. Tier
// and mark size come from the list's own RowGroup density, not this file. Weight is deliberately withheld from
// `intentic.` prefixes, full contribution lists, and a full-size switch.

const { entry, expanded, pending } = defineProps<{ entry: ExtensionEntry; expanded: boolean; pending: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; "update:expanded": [expanded: boolean] }>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);

// What the extension has actually done with its declared reach, from a per-route call ledger. With no observations yet
// (just installed, or never opened), the list renders exactly as before rather than guessing 'unneeded'.
const observed = computed(() => entry.extension.usage);
const routes = computed(() =>
    (manifest.value.permissions?.sandbox ?? []).map((route) => {
        const calls = observed.value?.[route]?.calls ?? 0;
        return { route, calls, unused: observed.value !== undefined && calls === 0 };
    }),
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
            const result = ExtensionReadinessSchema.parse(await sandboxJson(`/extensions/${encodeURIComponent(entry.extension.id)}/readiness`));
            readiness.value = [...result.checks];
        } catch (failure) {
            readiness.value = undefined;
            readinessError.value = errorMessage(failure, `Could not check this extension.`);
        }
    },
    { immediate: true },
);

// All checks ran and none failed; a warning stays the author's call, not a blocker.
const publishable = computed(() => readiness.value !== undefined && !readiness.value.some((check) => check.status === `fail`));
const publish = computed(() => ({
    id: extensionIdOf(manifest.value),
    dir: `.intentic/config/workspace-extensions/${manifest.value.name}`,
    name: manifest.value.name,
}));

// A workspace extension's name is its directory (one per subdirectory), so no round trip is needed.
const tighten = computed(() => ({
    id: extensionIdOf(manifest.value),
    dir: `.intentic/config/workspace-extensions/${manifest.value.name}`,
    unused: routes.value.filter((route) => route.unused).map((route) => route.route),
    used: routes.value.filter((route) => route.calls > 0).map(({ route, calls }) => ({ route, calls })),
}));

// How many places fit on a line before the column starts eating words rather than items.
const PLACES_SHOWN = 3;
// Ordered by facetsOf's visibility ranking. The breakdown below keeps the non-surface facets (e.g. watched files) but
// drops settings, which the form below renders better than a title list.
const places = computed(() => entry.facets.filter((facet) => facet.surface).map((facet) => facet.label));
const shown = computed(() => places.value.slice(0, PLACES_SHOWN).join(` · `));
const hidden = computed(() => places.value.slice(PLACES_SHOWN));
const breakdown = computed(() => entry.facets.filter((facet) => facet.kind !== `settings`));

// What flipping the switch doesn't reach immediately; stated under the fold, before the flip, rather than on every
// closed row.
const DEFERRED: Record<string, string> = {
    agent: `its agent skills, hooks and MCP servers apply from the next turn`,
    bin: `its CLIs leave the agent's PATH from the next turn`,
    environment: `its image fragment only changes at the next environment rebuild`,
};

const consequences = computed<string[]>(() => {
    const deferred = Object.keys(manifest.value.contributes ?? {}).flatMap((kind) => DEFERRED[kind] ?? []);
    if (entry.dependents.length === 0) {
        return deferred;
    }
    const named = entry.dependents.map((capability) => capability.id).join(`, `);
    const plural = entry.dependents.length === 1 ? `` : `s`;
    return [...deferred, `${entry.dependents.length} configured connector${plural} (${named}) keep their config but lose their Capabilities card`];
});

// A left-edge accent, not a full tint: a bare `border-danger` would repaint this list's row divider too, since that's a
// border on the row itself.
const ACCENT: Record<string, string> = { danger: `border-l-danger/70`, warning: `border-l-warning/70` };
const accent = computed(() => (entry.state.attention ? ACCENT[entry.state.variant] : undefined));

// Muted by default: anything the host explained without ranking as an exception is a fact, not an alarm.
const TONE: Record<string, string> = { danger: `text-danger`, warning: `text-warning` };
const tone = computed(() => TONE[entry.state.variant] ?? `text-muted`);
</script>

<template>
    <!--
        Header and detail share one tint while open, so it reads as one block; an ink wash, since canvas and card are barely distinct in light mode.
        `body="drawer"`: what opens is the extension's whole record under its own headings, not evidence hanging off the name.
    -->
    <DisclosureRow
        class="@container border-l-2"
        :class="accent ?? `border-l-transparent`"
        body="drawer"
        :open="expanded"
        @update:open="emit(`update:expanded`, !expanded)"
    >
        <template #lead="{ mark }">
            <!--
                Dimmed and desaturated when off, so the mark goes quiet with the rest of the row. `mark`'s size comes from the list's own tier, not
                this file.
            -->
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
                <!--
                    Dimming never touches the switch, the one control that still does something on an off row. The name recedes by ink color, not
                    opacity, which would read muddier and drop the hover tint.
                -->
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

        <!-- Shown only while closed: once open, the record below states it in full, and a truncated copy would be noise. -->
        <template v-if="entry.detail && !expanded" #description>
            <span class="block truncate" :class="tone">{{ entry.detail }}</span>
        </template>

        <template #control>
            <div class="flex shrink-0 items-center gap-2.5">
                <!-- Ambient unless the update is a security fix, which promotes it to the loud tier; a real exception badge still outranks it. -->
                <StatusBadge
                    v-if="!entry.state.attention && entry.extension.update !== undefined"
                    :variant="entry.extension.update.securityFix ? `danger` : `info`"
                    :label="entry.extension.update.securityFix ? `security update` : `update`"
                    size="xs"
                />
                <StatusBadge v-if="entry.state.badge" :variant="entry.state.variant" :label="entry.state.label" size="xs" />
                <span v-else-if="entry.state.label !== undefined" class="text-2xs text-subtle">{{ entry.state.label }}</span>
                <!--
                    Fixed, not hidden: a vanished control reads as a bug. Its engine runs regardless, so off would only blind the owner to it; the
                    daemon refuses the flip too, this just says so first.
                -->
                <span
                    v-if="entry.extension.essential"
                    :title="`Always on: this is the only window onto work the sandbox does on its own.`"
                    class="cursor-not-allowed"
                >
                    <ToggleSwitch
                        class="ui-switch-sm pointer-events-none"
                        :model-value="true"
                        disabled
                        :aria-label="`${extensionIdOf(manifest)} is always on`"
                    />
                </span>
                <ToggleSwitch
                    v-else
                    class="ui-switch-sm"
                    :model-value="entry.extension.enabled"
                    :disabled="pending"
                    :aria-label="`Enable ${extensionIdOf(manifest)}`"
                    @update:model-value="(value: boolean) => emit(`toggle`, value)"
                />
            </div>
        </template>

        <!-- The full record, one click away. -->
        <template #below>
            <div class="flex flex-col gap-4">
                <p v-if="entry.detail" class="text-xs" :class="tone">{{ entry.detail }}</p>

                <dl v-if="breakdown.length > 0" class="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                    <template v-for="facet in breakdown" :key="`${facet.kind}:${facet.label}`">
                        <dt class="text-xs text-subtle">{{ facet.label }}</dt>
                        <dd class="min-w-0 text-xs text-content">{{ facet.names.join(` · `) }}</dd>
                    </template>
                </dl>

                <!-- Only a git-installed extension has an update lifecycle; a builtin updates with the image, a workspace one is live-edited. -->
                <ExtensionUpdateCard v-if="entry.extension.source === `installed`" :extension="entry.extension" />

                <div v-if="settings.length > 0">
                    <p :class="ui.sectionLabel(`mb-2 text-2xs`)">Settings</p>
                    <ExtensionSettingsForm :extension-id="entry.extension.id" :settings="settings" />
                </div>

                <div v-if="entry.extension.enabled && consequences.length > 0">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs`)">Switching it off</p>
                    <ul class="flex flex-col gap-1">
                        <li v-for="consequence in consequences" :key="consequence" class="text-2xs text-muted">— {{ consequence }}.</li>
                    </ul>
                </div>

                <!--
                    The reach approved at install, and now whether it was ever used. A never-called route is drawn hollow, not as a warning: it's a
                    question for the maintainer, not a fault.
                -->
                <div v-if="manifest.permissions !== undefined">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs`)">Daemon routes it may call</p>
                    <div class="flex flex-wrap gap-1">
                        <code
                            v-for="route in routes"
                            :key="route.route"
                            class="rounded px-1.5 py-0.5 text-2xs"
                            :class="route.unused ? `border border-dashed border-line text-subtle` : `border border-line bg-canvas text-muted`"
                            v-tooltip.top="
                                route.calls > 0
                                    ? `Called ${route.calls.toLocaleString()} times`
                                    : route.unused
                                      ? `Never called since this was first observed`
                                      : undefined
                            "
                            >{{ route.route }}</code
                        >
                    </div>
                    <p v-if="observed === undefined" class="mt-1.5 text-2xs text-subtle">
                        Nothing observed yet: routes are counted as the extension uses them.
                    </p>
                    <p v-else-if="routes.some((route) => route.unused)" class="mt-1.5 text-2xs text-subtle">
                        Dashed routes have never been called. That is worth raising with whoever maintains it, not acting on alone: a route used only
                        by a screen you have not opened looks identical.
                        <!--
                            The one case where 'raise it with the maintainer' means the owner is the maintainer; the turn reviews routes one by one
                            rather than deleting what's dashed (see tightenBrief).
                        -->
                        <button v-if="tightenable" type="button" :class="ui.linkButton(`text-2xs`)" @click="startAgent(tightenBrief(tighten))">
                            Have an agent go through them
                        </button>
                    </p>
                </div>

                <!--
                    Checks only what's answerable off the files: the daemon serves this entry live, so something that only works because of how it's
                    loaded here looks fine until it's a commit elsewhere.
                -->
                <div v-if="entry.extension.source === `workspace`">
                    <p :class="ui.sectionLabel(`mb-1.5 text-2xs`)">Fit to publish</p>
                    <p v-if="readinessError" class="text-2xs text-danger">{{ readinessError }}</p>
                    <ul v-else-if="readiness" class="flex flex-col gap-1">
                        <li v-for="check in readiness" :key="check.id" class="flex gap-1.5 text-2xs">
                            <Icon
                                :name="check.status === `pass` ? `check` : check.status === `warn` ? `exclamation-triangle` : `times`"
                                :class="check.status === `pass` ? `text-success` : check.status === `warn` ? `text-warning` : `text-danger`"
                                class="mt-0.5 shrink-0"
                            />
                            <span class="text-muted"
                                >{{ check.label }}: <span class="text-subtle">{{ check.detail }}</span></span
                            >
                        </li>
                    </ul>
                    <!--
                        Offered only when nothing fails; a warning is the author's call, not a blocker. The turn itself is an ordinary, watched chat
                        (see publishBrief).
                    -->
                    <p v-if="publishable" class="mt-1.5 text-2xs text-subtle">
                        <button type="button" :class="ui.linkButton(`text-2xs`)" @click="startAgent(publishBrief(publish))">
                            Publish it: an agent pushes these files and reports the commit
                        </button>
                    </p>
                </div>

                <!-- The full id, version and commit a collapsed row leaves off. -->
                <p class="text-2xs text-subtle">
                    <span class="text-muted">{{ extensionIdOf(manifest) }}</span> · v{{ manifest.version }} ·
                    {{
                        entry.extension.source === `builtin`
                            ? `built into the sandbox image`
                            : entry.extension.source === `workspace`
                              ? `from .intentic/config/workspace-extensions`
                              : `installed · ${entry.extension.commit.slice(0, 12)}`
                    }}
                    · needs intentic
                    {{ manifest.engines.intentic }}
                </p>
            </div>
        </template>
    </DisclosureRow>
</template>
