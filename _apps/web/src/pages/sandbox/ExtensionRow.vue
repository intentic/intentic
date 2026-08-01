<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-api";
import { cmp, StatusBadge } from "@intentic-app/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { ExtensionEntry } from "../../composables/extensions/useExtensionList";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";

/* ONE EXTENSION, on one line until asked otherwise.
 *
 * The line answers the two questions a list is scanned for — what is this, and where does it show up — and
 * nothing else: `intentic.` in the subtle tone so the eye lands on the name that differs, then the places it
 * contributes to ("rail tile · 1 command · agent plugin"), then the switch. Version, commit, contribution
 * counts, the consequences of switching it off and the settings form all moved BELOW the fold, because none of
 * them is read while scanning and all of them were being paid for on every row.
 *
 * Expanding is therefore the whole design, not a nicety: the row is a summary that a click turns into the full
 * record. The tab keeps one row open at a time, so the list never grows unpredictably under the pointer. */

const { entry, expanded, pending } = defineProps<{ entry: ExtensionEntry; expanded: boolean; pending: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; "update:expanded": [expanded: boolean] }>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);
// The line's places, in the order facetsOf ranks them by visibility. The breakdown below the fold keeps the
// non-surface ones (watched files) and drops settings, which the form renders far better than a list of titles.
const places = computed(() =>
    entry.facets
        .filter((facet) => facet.surface)
        .map((facet) => facet.label)
        .join(` · `),
);
const breakdown = computed(() => entry.facets.filter((facet) => facet.kind !== `settings`));

/* What switching this extension off does NOT reach right away. Views, viewers, commands, processes, connectors,
 * listeners and settings all converge before the toggle returns; these three can't, so the row says so rather
 * than leaving the owner to discover it. It lives under the fold with the switch's other consequence — stated
 * before the flip for anyone who opens the row, instead of shouted on a row nobody is about to flip. */
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
</script>

<template>
    <!-- Header and detail share one tint while open, so an expanded row reads as a single block rather than as
         a row that happens to have grown a panel under it. The tint is an ink wash rather than `bg-canvas`
         because canvas and card are one step apart in light mode — a treatment that only exists in the dark
         scheme is a treatment that isn't there. -->
    <div :class="expanded ? `bg-content/5` : `transition-colors hover:bg-content/5`">
        <div class="flex items-center gap-3 px-3">
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2 text-left"
                :aria-expanded="expanded"
                @click="emit(`update:expanded`, !expanded)"
            >
                <Icon
                    name="chevron-right"
                    class="shrink-0 text-2xs text-subtle transition-transform"
                    :class="expanded ? `rotate-90` : undefined"
                    aria-hidden="true"
                />
                <!-- Dimming is on the TEXT, never on the switch: a faded control reads as unavailable, and the
                     switch is the one thing on a switched-off row that still does something. -->
                <span class="min-w-0 flex-1 truncate text-sm sm:w-52 sm:flex-none" :class="entry.extension.enabled ? undefined : `opacity-50`">
                    <span class="text-subtle">{{ manifest.publisher }}.</span><span class="font-medium text-content">{{ manifest.name }}</span>
                </span>
                <span
                    v-tooltip.overflow="places"
                    class="hidden min-w-0 flex-1 truncate text-xs text-muted sm:block"
                    :class="entry.extension.enabled ? undefined : `opacity-50`"
                    >{{ places }}</span
                >
            </button>
            <div class="flex shrink-0 items-center gap-2.5">
                <StatusBadge v-if="entry.state.badge" :variant="entry.state.variant" :label="entry.state.label" size="xs" />
                <span v-else-if="entry.state.label !== undefined" class="text-2xs text-subtle">{{ entry.state.label }}</span>
                <ToggleSwitch
                    :model-value="entry.extension.enabled"
                    :disabled="pending"
                    :aria-label="`Enable ${extensionIdOf(manifest)}`"
                    @update:model-value="(value: boolean) => emit(`toggle`, value)"
                />
            </div>
        </div>

        <!-- The full record, one click away. Indented to the name's column so it reads as belonging to the row
             above it rather than as a new section. -->
        <div v-if="expanded" class="flex flex-col gap-3 border-t border-line py-3 pl-9 pr-3">
            <p v-if="entry.detail" class="text-xs" :class="entry.state.variant === `danger` ? `text-danger` : `text-warning`">{{ entry.detail }}</p>

            <dl v-if="breakdown.length > 0" class="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
                <template v-for="facet in breakdown" :key="`${facet.kind}:${facet.label}`">
                    <dt class="text-xs text-subtle">{{ facet.label }}</dt>
                    <dd class="min-w-0 text-xs text-content">{{ facet.names.join(` · `) }}</dd>
                </template>
            </dl>

            <div v-if="settings.length > 0">
                <p :class="cmp.sectionLabel(`mb-1.5 text-2xs`)">Settings</p>
                <ExtensionSettingsForm :extension-id="entry.extension.id" :settings="settings" />
            </div>

            <div v-if="entry.extension.enabled && consequences.length > 0">
                <p :class="cmp.sectionLabel(`mb-1 text-2xs`)">Switching it off</p>
                <ul class="flex flex-col gap-0.5">
                    <li v-for="consequence in consequences" :key="consequence" class="text-2xs text-muted">— {{ consequence }}.</li>
                </ul>
            </div>

            <!-- The daemon reach the owner approved at install, and the only place it is visible afterwards. -->
            <div v-if="manifest.permissions !== undefined">
                <p :class="cmp.sectionLabel(`mb-1 text-2xs`)">Daemon routes it may call</p>
                <div class="flex flex-wrap gap-1">
                    <code
                        v-for="route in manifest.permissions.sandbox"
                        :key="route"
                        class="rounded border border-line px-1.5 py-0.5 text-2xs text-muted"
                        >{{ route }}</code
                    >
                </div>
            </div>

            <p class="text-2xs text-subtle">
                v{{ manifest.version }} ·
                {{ entry.extension.builtin ? `built into the sandbox image` : `installed · ${entry.extension.commit.slice(0, 12)}` }} · needs intentic
                {{ manifest.engines.intentic }}
            </p>
        </div>
    </div>
</template>
