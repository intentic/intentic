<script setup lang="ts">
import type { IconName, Tip } from "@intentic/ui";
import { computed } from "vue";
import CatalogTile from "../../../components/catalog/CatalogTile.vue";
import type { ExtensionEntry } from "../../extensions/useExtensionList";
import { devLineOf } from "./extensionDev";
import ExtensionSwitch from "./ExtensionSwitch.vue";
import { useT } from "@intentic/ui/i18n";

// One installed extension, drawn as Browse draws a published one (<CatalogTile>, in the same grid), so the section's two
// halves read as one catalog: its mark, the publisher before the name, and one line under it. That line says the most
// urgent thing true of it: what is wrong, then where it runs from when that is not its pinned copy, then where it shows
// up in the editor (nothing in a manifest says what it does). A coloured state and an update on offer are glyphs beside
// the name, each with its words in a tooltip, as Browse marks its listings. Pressing the tile opens the extension's page
// in the list's place (ExtensionDetail); the switch is the one control a tile keeps, because on and off is what people
// come to this list to do, and it sits outside the press so switching never also opens.

const t = useT();

// `manage` is whether this reader may switch it: below maintainer the tile is a fact, with no switch to press.
const { entry, pending, manage } = defineProps<{ entry: ExtensionEntry; pending: boolean; manage: boolean }>();

const emit = defineEmits<{ toggle: [enabled: boolean]; open: [] }>();

const extension = computed(() => entry.extension);
const manifest = computed(() => entry.extension.manifest);

// The host's own colour where it ranked the state; anything it explained without ranking is a fact, in the line's grey.
const ink = computed(() => (entry.state.variant === `danger` ? `text-danger` : entry.state.variant === `warning` ? `text-warning` : `text-muted`));

// Where its code comes from, for an extension that shows up nowhere a reader can point at.
const sourceWords = computed(() => {
    switch (entry.extension.source) {
        case `builtin`:
            return t(`sandbox.extensionRow.sourceBuiltin`);
        case `workspace`:
            return t(`sandbox.extensionRow.sourceWorkspace`);
        default:
            return t(`sandbox.extensionRow.sourceInstalled`);
    }
});

// The one line under the name: what it says, and in which ink.
interface TileLine {
    readonly text: string;
    readonly ink: string;
}

const line = computed((): TileLine => {
    if (entry.detail) {
        return { text: entry.detail, ink: ink.value };
    }
    const dev = devLineOf(entry.extension);
    if (dev !== undefined) {
        return { text: dev, ink: entry.extension.dev?.held === undefined ? `text-muted` : `text-warning` };
    }
    // A coloured state with no sentence behind it is said in its own word, so a glyph is never the only place it is.
    if (entry.state.label !== undefined && entry.state.variant !== `neutral`) {
        return { text: entry.state.label, ink: ink.value };
    }
    // Where it shows up, ordered by facetsOf's visibility ranking, so what a reader can point at comes first and the cut
    // falls on plumbing. A fact merely worth knowing ("agent-only", "reload to load") follows them: it is what a reader
    // scans for least, and its page says it too.
    const places = entry.facets.filter((facet) => facet.surface).map((facet) => facet.label);
    const said = [...places, ...(entry.state.label === undefined ? [] : [entry.state.label])];
    // Off, it goes quiet with its name and mark: still true, just not doing anything.
    return { text: said.length === 0 ? sourceWords.value : said.join(` · `), ink: entry.extension.enabled ? `text-muted` : `text-subtle` };
});

// The state's glyph: a registry block is the ban Browse draws for one, anything else its severity's sign.
const stateMark = computed((): { icon: IconName; ink: string; tip: Tip } | undefined => {
    const { badge, label, variant } = entry.state;
    if (!badge || label === undefined) {
        return undefined;
    }
    const danger = variant === `danger`;
    return {
        icon: entry.extension.advisory === undefined ? (danger ? `exclamation-circle` : `exclamation-triangle`) : `ban`,
        ink: ink.value,
        tip: { title: `${label.charAt(0).toLocaleUpperCase()}${label.slice(1)}`, tone: danger ? `danger` : `warning` },
    };
});

// An update on offer, unless something worse already pins the tile: its page says both, and the trouble comes first.
// A security fix wears danger, as the update card it opens on does.
const updateMark = computed((): { ink: string; tip: Tip } | undefined => {
    const offer = entry.extension.update;
    if (offer === undefined || entry.state.attention) {
        return undefined;
    }
    return offer.securityFix
        ? {
              ink: `text-danger`,
              tip: { title: t(`sandbox.extensionUpdateOffer.securityUpdateAvailable`), tone: `danger`, note: t(`sandbox.extensionRow.reviewUpdate`) },
          }
        : {
              ink: `text-info`,
              tip: { title: t(`sandbox.extensionUpdateOffer.updateAvailable`), tone: `info`, note: t(`sandbox.extensionRow.reviewUpdate`) },
          };
});
</script>

<template>
    <!-- Built-ins are named bare, as the sandbox names them; anything installed or written here carries its publisher, the trust fact. -->
    <CatalogTile
        :name="manifest.name"
        :prefix="extension.source === `builtin` ? undefined : manifest.publisher"
        :art="manifest.art"
        :logo="manifest.logo"
        :icon="manifest.icon"
        :idle="!extension.enabled"
        @click="emit(`open`)"
    >
        <template #marks>
            <Icon
                v-if="stateMark"
                v-tooltip.top="stateMark.tip"
                :name="stateMark.icon"
                class="shrink-0 text-2xs"
                :class="stateMark.ink"
                :aria-label="stateMark.tip.title"
            />
            <Icon
                v-if="updateMark"
                v-tooltip.top="updateMark.tip"
                name="arrow-circle-up"
                class="shrink-0 text-2xs"
                :class="updateMark.ink"
                :aria-label="updateMark.tip.title"
            />
        </template>
        <!-- Cut to the tile's width like every tile's line; the whole of it shows on hover only when it was cut. -->
        <template #description>
            <span v-tooltip.overflow="line.text" class="block truncate first-letter:uppercase" :class="line.ink">{{ line.text }}</span>
        </template>
        <template v-if="manage" #control>
            <ExtensionSwitch :extension="extension" :pending="pending" @toggle="(enabled) => emit(`toggle`, enabled)" />
        </template>
    </CatalogTile>
</template>
