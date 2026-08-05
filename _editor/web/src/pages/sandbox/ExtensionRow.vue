<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-api";
import { BrandMark, cmp, StatusBadge } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { ExtensionEntry } from "../../composables/extensions/useExtensionList";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";

/* ONE EXTENSION, on one line until asked otherwise.
 *
 * The line answers the two questions a list is scanned for — what is this, and where does it show up — and
 * nothing else: the name, then the places it contributes to ("rail tile · 1 command · agent plugin"), then the
 * switch. Version, commit, contribution counts, the consequences of switching it off and the settings form all
 * moved BELOW the fold, because none of them is read while scanning and all of them were being paid for on
 * every row.
 *
 * Expanding is therefore the whole design, not a nicety: the row is a summary that a click turns into the full
 * record. The tab keeps one row open at a time, so the list never grows unpredictably under the pointer.
 *
 * THE ONE THING WORTH ITS WEIGHT that isn't words: the manifest's mark. It is the only element here that can be
 * found without reading — twenty-odd rows of grey text differ solely in their middle, and half of these
 * extensions never reach the rail, so for them this is the ONLY place they are ever drawn as anything. It costs
 * no vertical space (22px inside a 40px row) and no horizontal decision (it sits in the chevron's column), which
 * is precisely what the three refusals below are about: they each cost a word, a wrap or a scan.
 *
 * THREE THINGS THE ROW REFUSES TO SPEND WEIGHT ON, because fifteen rows pay for each of them:
 *
 *  1. `intentic.` in front of every name. It is the publisher of every extension the image bakes in, so on a
 *     first-party row it is nine characters of nothing — the eye skips them fifteen times to reach the word
 *     that differs. It rides an INSTALLED extension's row, where the publisher is the provenance the owner
 *     approved, and the full id stays on the open row and in the switch's accessible name.
 *  2. A character-level ellipsis through the contributions. "…agent plugi…" says only that the column ran out;
 *     three whole places and a `+2` says what was dropped, and hovering the `+2` names them.
 *  3. A full-size switch. The compact one (`ui-switch-sm`) is the same control at half the area — see the note
 *     in primeng.css for why a list of toggles is not a card with a toggle on it. */

const { entry, expanded, pending } = defineProps<{ entry: ExtensionEntry; expanded: boolean; pending: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; "update:expanded": [expanded: boolean] }>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);

// How many places fit on a line before the column starts eating words rather than items.
const PLACES_SHOWN = 3;
// The line's places, in the order facetsOf ranks them by visibility. The breakdown below the fold keeps the
// non-surface ones (watched files) and drops settings, which the form renders far better than a list of titles.
const places = computed(() => entry.facets.filter((facet) => facet.surface).map((facet) => facet.label));
const shown = computed(() => places.value.slice(0, PLACES_SHOWN).join(` · `));
const hidden = computed(() => places.value.slice(PLACES_SHOWN));
const breakdown = computed(() => entry.facets.filter((facet) => facet.kind !== `settings`));

/* What switching this extension off does NOT reach right away. Views, viewers, commands, processes, capability cards,
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

// The exception rows carry their colour on a left edge rather than across the row: a tinted row competes with
// the switch for the same eye, and a 2px edge is legible down the whole group at a glance.
const ACCENT: Record<string, string> = { danger: `border-danger/70`, warning: `border-warning/70` };
const accent = computed(() => (entry.state.attention ? ACCENT[entry.state.variant] : undefined));

// The host's explanation of a non-nominal state, in the tone of the state it explains. Anything the host
// bothered to explain and did NOT rank as an exception is a fact, not an alarm — hence the muted default.
const TONE: Record<string, string> = { danger: `text-danger`, warning: `text-warning` };
const tone = computed(() => TONE[entry.state.variant] ?? `text-muted`);
</script>

<template>
    <!-- Header and detail share one tint while open, so an expanded row reads as a single block rather than as
         a row that happens to have grown a panel under it. The tint is an ink wash rather than `bg-canvas`
         because canvas and card are one step apart in light mode — a treatment that only exists in the dark
         scheme is a treatment that isn't there. -->
    <div class="group border-l-2" :class="[expanded ? `bg-content/6` : `transition-colors hover:bg-content/4`, accent ?? `border-transparent`]">
        <div class="flex items-center gap-3 pl-2.5 pr-3">
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 py-2.5 text-left"
                :aria-expanded="expanded"
                @click="emit(`update:expanded`, !expanded)"
            >
                <Icon
                    name="chevron-right"
                    class="shrink-0 text-2xs text-subtle transition-transform group-hover:text-muted"
                    :class="expanded ? `rotate-90` : undefined"
                    aria-hidden="true"
                />
                <!-- The one thing on the row that is not words. Dimmed AND desaturated when the extension is
                     off, so a brand logo goes quiet with the rest of the row instead of being the loudest
                     thing on the one row that is switched off. -->
                <BrandMark :size="22" :name="manifest.name" :logo="manifest.logo" :icon="manifest.icon" :idle="!entry.extension.enabled" />
                <span class="min-w-0 flex-1">
                    <span class="flex min-w-0 items-baseline gap-3">
                        <!-- Dimming is never on the switch: a faded control reads as unavailable, and the switch
                             is the one thing on a switched-off row that still does something. The name recedes
                             by changing INK rather than by opacity — a half-transparent word over a tinted row
                             is a muddier grey than the palette's own muted one, and it takes the hover tint
                             with it. -->
                        <span class="min-w-0 flex-1 truncate text-sm sm:w-48 sm:flex-none">
                            <span v-if="!entry.extension.builtin" class="text-subtle">{{ manifest.publisher }}.</span
                            ><span class="font-medium" :class="entry.extension.enabled ? `text-content` : `text-muted`">{{ manifest.name }}</span>
                        </span>
                        <span
                            class="hidden min-w-0 flex-1 items-baseline gap-1.5 text-xs sm:flex"
                            :class="entry.extension.enabled ? `text-muted` : `text-subtle`"
                        >
                            <span v-tooltip.overflow="shown" class="min-w-0 truncate">{{ shown }}</span>
                            <span v-if="hidden.length > 0" v-tooltip.top="hidden.join(` · `)" class="shrink-0 text-subtle">+{{ hidden.length }}</span>
                        </span>
                    </span>
                    <!-- An exception says WHAT went wrong where the reader already is: the badge names the kind
                         of failure, this names the failure. Only while the row is closed — open, the record
                         below states it in full, and a truncated copy of a line already on screen is noise. -->
                    <span v-if="entry.detail && !expanded" class="block truncate pt-0.5 text-2xs" :class="tone">{{ entry.detail }}</span>
                </span>
            </button>
            <div class="flex shrink-0 items-center gap-2.5">
                <StatusBadge v-if="entry.state.badge" :variant="entry.state.variant" :label="entry.state.label" size="xs" />
                <span v-else-if="entry.state.label !== undefined" class="text-2xs text-subtle">{{ entry.state.label }}</span>
                <ToggleSwitch
                    class="ui-switch-sm"
                    :model-value="entry.extension.enabled"
                    :disabled="pending"
                    :aria-label="`Enable ${extensionIdOf(manifest)}`"
                    @update:model-value="(value: boolean) => emit(`toggle`, value)"
                />
            </div>
        </div>

        <!-- The full record, one click away. Indented to the name's column so it reads as belonging to the row
             above it rather than as a new section. -->
        <div v-if="expanded" class="flex flex-col gap-4 border-t border-line py-3 pl-9 pr-3">
            <p v-if="entry.detail" class="text-xs" :class="tone">{{ entry.detail }}</p>

            <dl v-if="breakdown.length > 0" class="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                <template v-for="facet in breakdown" :key="`${facet.kind}:${facet.label}`">
                    <dt class="text-xs text-subtle">{{ facet.label }}</dt>
                    <dd class="min-w-0 text-xs text-content">{{ facet.names.join(` · `) }}</dd>
                </template>
            </dl>

            <div v-if="settings.length > 0">
                <p :class="cmp.sectionLabel(`mb-2 text-2xs`)">Settings</p>
                <ExtensionSettingsForm :extension-id="entry.extension.id" :settings="settings" />
            </div>

            <div v-if="entry.extension.enabled && consequences.length > 0">
                <p :class="cmp.sectionLabel(`mb-1.5 text-2xs`)">Switching it off</p>
                <ul class="flex flex-col gap-1">
                    <li v-for="consequence in consequences" :key="consequence" class="text-2xs text-muted">— {{ consequence }}.</li>
                </ul>
            </div>

            <!-- The daemon reach the owner approved at install, and the only place it is visible afterwards. -->
            <div v-if="manifest.permissions !== undefined">
                <p :class="cmp.sectionLabel(`mb-1.5 text-2xs`)">Daemon routes it may call</p>
                <div class="flex flex-wrap gap-1">
                    <code
                        v-for="route in manifest.permissions.sandbox"
                        :key="route"
                        class="rounded border border-line bg-canvas px-1.5 py-0.5 text-2xs text-muted"
                        >{{ route }}</code
                    >
                </div>
            </div>

            <!-- Identity, on its own hairline: the full id the collapsed row leaves off a baked-in extension,
                 with the version and commit that say WHICH code this is. -->
            <p class="border-t border-line pt-2.5 text-2xs text-subtle">
                <span class="text-muted">{{ extensionIdOf(manifest) }}</span> · v{{ manifest.version }} ·
                {{ entry.extension.builtin ? `built into the sandbox image` : `installed · ${entry.extension.commit.slice(0, 12)}` }} · needs intentic
                {{ manifest.engines.intentic }}
            </p>
        </div>
    </div>
</template>
