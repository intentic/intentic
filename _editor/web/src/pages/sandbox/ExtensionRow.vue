<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { ExtensionReadinessSchema } from "@intentic/sandbox-contract";
import { BrandMark, ui, StatusBadge } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { startAgent } from "../../composables/agents/agentActions";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import type { ExtensionEntry } from "../../composables/extensions/useExtensionList";
import { publishBrief, tightenBrief } from "./extensionBrief";
import ExtensionSettingsForm from "./ExtensionSettingsForm.vue";
import ExtensionUpdateCard from "./ExtensionUpdateCard.vue";

/* ONE EXTENSION, on one line until asked otherwise.
 *
 * The line answers the two questions a list is scanned for: what is this, and where does it show up, and
 * nothing else: the name, then the places it contributes to ("rail tile · 1 command · agent plugin"), then the
 * switch. Version, commit, contribution counts, the consequences of switching it off and the settings form all
 * moved BELOW the fold, because none of them is read while scanning and all of them were being paid for on
 * every row.
 *
 * Expanding is therefore the whole design, not a nicety: the row is a summary that a click turns into the full
 * record. The tab keeps one row open at a time, so the list never grows unpredictably under the pointer.
 *
 * THE ONE THING WORTH ITS WEIGHT that isn't words: the manifest's mark. It is the only element here that can be
 * found without reading: twenty-odd rows of grey text differ solely in their middle, and half of these
 * extensions never reach the rail, so for them this is the ONLY place they are ever drawn as anything. It costs
 * no vertical space (22px inside a 40px row) and no horizontal decision (it sits in the chevron's column), which
 * is precisely what the three refusals below are about: they each cost a word, a wrap or a scan.
 *
 * THREE THINGS THE ROW REFUSES TO SPEND WEIGHT ON, because fifteen rows pay for each of them:
 *
 *  1. `intentic.` in front of every name. It is the publisher of every extension the image bakes in, so on a
 *     first-party row it is nine characters of nothing: the eye skips them fifteen times to reach the word
 *     that differs. It rides an INSTALLED extension's row, where the publisher is the provenance the owner
 *     approved, and the full id stays on the open row and in the switch's accessible name.
 *  2. A character-level ellipsis through the contributions. "…agent plugi…" says only that the column ran out;
 *     three whole places and a `+2` says what was dropped, and hovering the `+2` names them.
 *  3. A full-size switch. The compact one (`ui-switch-sm`) is the same control at half the area: see the note
 *     in primeng.css for why a list of toggles is not a card with a toggle on it. */

const { entry, expanded, pending } = defineProps<{ entry: ExtensionEntry; expanded: boolean; pending: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; "update:expanded": [expanded: boolean] }>();

const manifest = computed(() => entry.extension.manifest);
const settings = computed(() => manifest.value.contributes?.settings ?? []);

/* WHAT THE EXTENSION HAS ACTUALLY DONE WITH THE REACH IT ASKED FOR. The permission list below used to state a
 * claim nobody could check; each route now carries how often it has been called, and the ones that never have
 * are marked.
 *
 * ONLY ONCE THE EXTENSION HAS BEEN EXERCISED AT ALL, which is the whole honesty of this. An extension installed
 * an hour ago has an empty ledger, and so does one whose view the owner has never opened: reading either as
 * "these permissions are unnecessary" would turn a measurement into a guess with a number on it, and the guess
 * would be pointing at the most consequential thing on the row. So with no observations the list renders exactly
 * as it did before, saying nothing it cannot support. */
const observed = computed(() => entry.extension.usage);
const routes = computed(() =>
    (manifest.value.permissions?.sandbox ?? []).map((route) => {
        const calls = observed.value?.[route]?.calls ?? 0;
        return { route, calls, unused: observed.value !== undefined && calls === 0 };
    }),
);

/* OFFERED ONLY WHERE THE OWNER CAN ACT. A workspace extension's manifest is a file in this workspace; an
 * installed one's is a file in somebody else's repository at a pinned commit, and editing it here would be
 * editing a checkout the next update overwrites. For those the figures stay informational: the honest thing to
 * do with them is raise it with whoever maintains it, which is what the note under the list says.
 *
 * It also needs something to act ON: at least one route observed used (so the extension has genuinely been
 * exercised) and at least one never called. */
const tightenable = computed(
    () =>
        entry.extension.source === `workspace` &&
        observed.value !== undefined &&
        routes.value.some((route) => route.unused) &&
        routes.value.some((route) => route.calls > 0),
);

/* IS IT FIT FOR SOMEBODY ELSE TO RUN. Fetched when the row opens rather than carried on the list: it reads the
 * bundle off disk per extension, and it is read when an author is thinking about publishing, not on every render
 * of a tab that has twenty rows.
 *
 * Shown for a WORKSPACE extension only, because that is the one an author is about to publish. The same checks
 * would be true of an installed extension, but there they describe somebody else's decision at a commit this
 * owner cannot change: a red cross against a thing you cannot fix is noise. */
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

// Publishable = the checks ran and none failed. Warnings stay the author's call: an unexercised permissions
// list is worth a look, not a locked door: the brief's own invariants carry the rest.
const publishable = computed(() => readiness.value !== undefined && !readiness.value.some((check) => check.status === `fail`));
const publish = computed(() => ({
    id: extensionIdOf(manifest.value),
    dir: `.intentic/config/workspace-extensions/${manifest.value.name}`,
    name: manifest.value.name,
}));

// The extension's own directory, which is where its manifest is. A workspace extension's name IS its directory
// (the daemon enumerates one per subdirectory), so this needs no round trip to find out.
const tighten = computed(() => ({
    id: extensionIdOf(manifest.value),
    dir: `.intentic/config/workspace-extensions/${manifest.value.name}`,
    unused: routes.value.filter((route) => route.unused).map((route) => route.route),
    used: routes.value.filter((route) => route.calls > 0).map(({ route, calls }) => ({ route, calls })),
}));

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
 * than leaving the owner to discover it. It lives under the fold with the switch's other consequence: stated
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

/* The exception rows carry their colour on a left edge rather than across the row: a tinted row competes with
 * the switch for the same eye, and a 2px edge is legible down the whole group at a glance.
 *
 * SIDE-SCOPED, and that is not tidiness. The group draws its hairline between rows as a border on the row
 * itself, so a bare `border-danger`, which sets every edge's colour, repaints that divider red: two broken
 * extensions in a row put a full-width red rule across the card. Only the left edge is ours to colour. */
const ACCENT: Record<string, string> = { danger: `border-l-danger/70`, warning: `border-l-warning/70` };
const accent = computed(() => (entry.state.attention ? ACCENT[entry.state.variant] : undefined));

// The host's explanation of a non-nominal state, in the tone of the state it explains. Anything the host
// bothered to explain and did NOT rank as an exception is a fact, not an alarm: hence the muted default.
const TONE: Record<string, string> = { danger: `text-danger`, warning: `text-warning` };
const tone = computed(() => TONE[entry.state.variant] ?? `text-muted`);
</script>

<template>
    <!-- Header and detail share one tint while open, so an expanded row reads as a single block rather than as
         a row that happens to have grown a panel under it. The tint is an ink wash rather than `bg-canvas`
         because canvas and card are one step apart in light mode: a treatment that only exists in the dark
         scheme is a treatment that isn't there. -->
    <div
        class="group @container border-l-2"
        :class="[expanded ? `bg-content/6` : `transition-colors hover:bg-content/4`, accent ?? `border-l-transparent`]"
    >
        <div class="flex items-center gap-3 pl-3 pr-3.5">
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-3 text-left"
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
                <BrandMark
                    :size="22"
                    :name="manifest.name"
                    :art="manifest.art"
                    :logo="manifest.logo"
                    :icon="manifest.icon"
                    :idle="!entry.extension.enabled"
                />
                <span class="min-w-0 flex-1">
                    <span class="flex min-w-0 items-baseline gap-3">
                        <!-- Dimming is never on the switch: a faded control reads as unavailable, and the switch
                             is the one thing on a switched-off row that still does something. The name recedes
                             by changing INK rather than by opacity: a half-transparent word over a tinted row
                             is a muddier grey than the palette's own muted one, and it takes the hover tint
                             with it. -->
                        <span class="min-w-0 flex-1 truncate text-sm @2xl:w-48 @2xl:flex-none">
                            <span v-if="entry.extension.source !== `builtin`" class="text-subtle">{{ manifest.publisher }}.</span
                            ><span class="font-medium" :class="entry.extension.enabled ? `text-content` : `text-muted`">{{ manifest.name }}</span>
                        </span>
                        <span
                            class="hidden min-w-0 flex-1 items-baseline gap-1.5 text-xs @2xl:flex"
                            :class="entry.extension.enabled ? `text-muted` : `text-subtle`"
                        >
                            <span v-tooltip.overflow="shown" class="min-w-0 truncate">{{ shown }}</span>
                            <span v-if="hidden.length > 0" v-tooltip.top="hidden.join(` · `)" class="shrink-0 text-subtle">+{{ hidden.length }}</span>
                        </span>
                    </span>
                    <!-- An exception says WHAT went wrong where the reader already is: the badge names the kind
                         of failure, this names the failure. Only while the row is closed: open, the record
                         below states it in full, and a truncated copy of a line already on screen is noise. -->
                    <span v-if="entry.detail && !expanded" class="block truncate pt-0.5 text-2xs" :class="tone">{{ entry.detail }}</span>
                </span>
            </button>
            <div class="flex shrink-0 items-center gap-2.5">
                <!-- The update badge is AMBIENT unless the listing says the old version is the dangerous one:
                     a security fix promotes it to the loud tier, because waiting is what needs the eye there.
                     It yields to any real exception badge: a broken row's problem outranks its update. -->
                <StatusBadge
                    v-if="!entry.state.attention && entry.extension.update !== undefined"
                    :variant="entry.extension.update.securityFix ? `danger` : `info`"
                    :label="entry.extension.update.securityFix ? `security update` : `update`"
                    size="xs"
                />
                <StatusBadge v-if="entry.state.badge" :variant="entry.state.variant" :label="entry.state.label" size="xs" />
                <span v-else-if="entry.state.label !== undefined" class="text-2xs text-subtle">{{ entry.state.label }}</span>
                <!-- An essential surface's switch is FIXED, not hidden: a control that vanishes reads as a bug,
                     one that is visibly on and immovable reads as a fact. The title carries the why: its engine
                     runs whether or not anything draws it, so off would not stop anything, only blind the owner
                     to it. The daemon refuses the flip regardless; this only says so before the click. -->
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
        </div>

        <!-- The full record, one click away. Indented to the name's column so it reads as belonging to the row
             above it rather than as a new section. -->
        <div v-if="expanded" class="flex flex-col gap-4 border-t border-line py-3.5 pl-10 pr-4">
            <p v-if="entry.detail" class="text-xs" :class="tone">{{ entry.detail }}</p>

            <dl v-if="breakdown.length > 0" class="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-x-4 gap-y-1.5">
                <template v-for="facet in breakdown" :key="`${facet.kind}:${facet.label}`">
                    <dt class="text-xs text-subtle">{{ facet.label }}</dt>
                    <dd class="min-w-0 text-xs text-content">{{ facet.names.join(` · `) }}</dd>
                </template>
            </dl>

            <!-- The update lifecycle: only a git-installed extension has one (a builtin updates with the
                 image, a workspace one is live-edited), and the daemon only sends its fields for those. -->
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

            <!-- The daemon reach the owner approved at install, the only place it is visible afterwards, and now
                 also whether it was ever needed. A never-called route is drawn hollow rather than in a warning
                 colour: it is a question for whoever maintains the extension, not a fault of the install. -->
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
                    Dashed routes have never been called. That is worth raising with whoever maintains it, not acting on alone: a route used only by
                    a screen you have not opened looks identical.
                    <!-- The one case where "raise it with the maintainer" means "you are the maintainer": this
                         manifest is a file in this workspace. The turn it starts reads the code and decides route
                         by route rather than deleting what is dashed: see tightenBrief. -->
                    <button v-if="tightenable" type="button" :class="ui.linkButton(`text-2xs`)" @click="startAgent(tightenBrief(tighten))">
                        Have an agent go through them
                    </button>
                </p>
            </div>

            <!-- Only for a workspace extension, and only what is answerable off its files. The failures here are
                 the ones that are invisible in this workspace: the daemon serves the entry live, so a bundle
                 that only works because of how it is being loaded here looks perfect until it is a commit in
                 somebody else's sandbox. -->
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
                <!-- Offered only when nothing FAILS: a warning is the author's judgement call and must not bar
                     the door, but a failing check names something every installer would hit. The turn itself is
                     an ordinary chat (see publishBrief): publishing is watched, not fired and forgotten. -->
                <p v-if="publishable" class="mt-1.5 text-2xs text-subtle">
                    <button type="button" :class="ui.linkButton(`text-2xs`)" @click="startAgent(publishBrief(publish))">
                        Publish it: an agent pushes these files and reports the commit
                    </button>
                </p>
            </div>

            <!-- Identity: the full id the collapsed row leaves off a baked-in extension,
                 with the version and commit that say WHICH code this is. -->
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
    </div>
</template>
