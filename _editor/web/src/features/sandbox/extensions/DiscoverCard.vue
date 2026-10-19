<script setup lang="ts">
import type { Tip } from "@intentic/ui";
import { computed } from "vue";
import CatalogTile from "../../../components/CatalogTile.vue";
import { checksProblem, checksTip, type DiscoverListing, splitListingName } from "../../../models/sandbox/discoverListing";
import { useT } from "@intentic/ui/i18n";

// One published extension, drawn as the tile the Capabilities catalog draws, at the same density: the publisher before
// the name (a trust fact, as the Installed list names it), what it does on the second line, and its state as glyphs on
// the first, each carrying its sentence in a tooltip. Version, stars and the trust record are the listing's page.
// Installing happens on that page as well, because the trust argument is made there.

const t = useT();

const { listing, installing = false } = defineProps<{
    listing: DiscoverListing;
    /** Its install or update is running: the tile says so, since the page it was started from may be closed. */
    installing?: boolean;
}>();

const name = computed(() => splitListingName(listing.entry.name));
const problem = computed(() => checksProblem(listing.entry));
const dim = computed(() => listing.state.kind === `blocked` || listing.state.kind === `unavailable`);

const unauditedTip = computed((): Tip => ({
    title: t(`sandbox.discoverCard.notAudited`),
    tone: `warning`,
    note: t(`sandbox.discoverCard.reviewBeforeInstall`),
}));
// The registry's own words for a verified listing where it gave some; ours, cut to what was done, where it did not.
const verifiedTip = computed(
    (): Tip | string => listing.entry.trustReason ?? { title: t(`sandbox.words.verified`), note: t(`sandbox.discoverCard.scannedAuditedRead`) },
);
// Why a listing can't be installed in one click, in two words: nowhere to clone from, or no exact commit to clone.
const unavailableTip = computed(() =>
    listing.entry.install === undefined ? t(`sandbox.discoverCard.cantClone`) : t(`sandbox.discoverCard.notPinned`),
);
</script>

<template>
    <!-- The whole tile opens the listing, even when blocked: that's the listing a reader most needs to read. -->
    <CatalogTile
        :name="name.title"
        :prefix="name.publisher || undefined"
        :description="listing.entry.description"
        :art="listing.entry.art"
        :logo="listing.entry.logo"
        :icon="listing.entry.icon"
        :idle="dim"
    >
        <template #marks>
            <!-- The only trust mark said out loud: marking 'listed' too would dress the honest default up as a review. -->
            <Icon
                v-if="listing.entry.trust === `verified`"
                v-tooltip.top="verifiedTip"
                name="shield"
                class="shrink-0 text-2xs text-success"
                :aria-label="t(`sandbox.words.verified`)"
            />
            <!-- The nightly scan passing is the default and goes unsaid; failing it is said. -->
            <Icon
                v-if="problem"
                v-tooltip.top="checksTip(listing.entry)"
                name="exclamation-triangle"
                class="shrink-0 text-2xs text-warning"
                :aria-label="t(`sandbox.discoverCard.wontLoad`)"
            />
            <!-- Where it stands here, after what it is: one glyph, the one that changes what a press leads to. A running
                 install also says so in words, since a bare spinner on a tile reads as the tile loading. -->
            <span v-if="installing" class="flex shrink-0 items-center gap-1 text-2xs text-muted" role="status">
                <Icon name="spinner" spin aria-hidden="true" />
                {{ listing.state.kind === `update` ? t(`sandbox.discoverCard.updating`) : t(`sandbox.discoverCard.installing`) }}
            </span>
            <Icon
                v-else-if="listing.state.kind === `installed`"
                v-tooltip.top="t(`sandbox.discoverCard.installed`)"
                name="check-circle"
                class="shrink-0 text-2xs text-success"
                :aria-label="t(`sandbox.discoverCard.installed`)"
            />
            <Icon
                v-else-if="listing.state.kind === `update`"
                v-tooltip.top="listing.state.unaudited ? unauditedTip : t(`sandbox.discoverCard.update`)"
                name="arrow-circle-up"
                class="shrink-0 text-2xs"
                :class="listing.state.unaudited ? `text-warning` : `text-info`"
                :aria-label="listing.state.unaudited ? t(`sandbox.discoverCard.unauditedUpdate`) : t(`sandbox.discoverCard.update`)"
            />
            <Icon
                v-else-if="listing.state.kind === `blocked`"
                v-tooltip.top="t(`shared.blocked`)"
                name="ban"
                class="shrink-0 text-2xs text-danger"
                :aria-label="t(`shared.blocked`)"
            />
            <Icon
                v-else-if="listing.state.kind === `unavailable`"
                v-tooltip.top="unavailableTip"
                name="times-circle"
                class="shrink-0 text-2xs text-subtle"
                :aria-label="t(`sandbox.discoverCard.cantInstall`)"
            />
            <Icon
                v-else-if="listing.state.unaudited"
                v-tooltip.top="unauditedTip"
                name="exclamation-triangle"
                class="shrink-0 text-2xs text-warning"
                :aria-label="t(`sandbox.discoverCard.unaudited`)"
            />
        </template>
        <template v-if="!listing.entry.description" #description>
            <span class="italic text-subtle">{{ t(`sandbox.discoverCard.noDescriptionPublished`) }}</span>
        </template>
    </CatalogTile>
</template>
