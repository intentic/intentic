<script setup lang="ts">
import Button from "primevue/button";
import { OFFICIAL_REGISTRY_URL } from "@intentic/registry";
import { cmp, FilterBar, Notice, type NoticeModel, NoticeStack, Segmented } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../composables/agents/agentActions";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { useRegistry } from "../../composables/extensions/useRegistry";
import { useRole } from "../../composables/sandbox/useRole";
import { useTerminalPanel } from "../../composables/terminal/useTerminalPanel";
import { noticeFrom } from "../../composables/useAsyncAction";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import { auditBrief, updateBrief } from "./extensionBrief";
import DiscoverCard from "./DiscoverCard.vue";
import DiscoverDetail from "./DiscoverDetail.vue";
import { type DiscoverListing, listingSections, toListing } from "./discoverListing";

/* DISCOVER — what other people have published, in the one place in this app that already means "extensions".
 *
 * This is a move, not a new feature: browsing a registry existed, buried five clicks deep inside an optional
 * block on a form on the Capabilities page, presented as a way to PRE-FILL A TEXT FIELD. Three things were
 * wrong with that and all three are what this file is shaped by.
 *
 *  1. A URL FIELD STOOD WHERE A SEARCH BOX BELONGS. The first thing the old surface asked for was the address
 *     of the registry — a reader who wanted to see what exists was asked to supply the thing that would show
 *     them. Here the list is already on screen (the official registry is the default read, not a default
 *     value in a box), the search box is the first control, and the registry is a source LINE with a way to
 *     change it. "Registries are plural" stays exactly as true; it stops being a toll.
 *  2. VERIFICATION WAS A GLYPH IN A SCROLLBOX. Somebody reading an author's source at a specific commit is the
 *     most expensive thing anyone does per listing, and it was rendered as a 12px shield between a version
 *     string and a star count. It is now the first section, with its claim written out — and the claim the
 *     OTHER section makes ("nobody read this") is written out too, because a page that only prints the good
 *     news is an advertisement.
 *  3. THERE WAS NOWHERE TO LEARN ANYTHING. A row was a truncated line and a click filled in a form. A stranger's
 *     extension needs a panel: what it is, whose it is, what is guaranteed and by whom, and the one thing this
 *     product can offer that a marketplace cannot — the reader's own agent, reading that exact commit before a
 *     single line of it runs.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT DO is claim more than it knows. It has no manifest to render: the
 * whole point of a listing is that the code has not been cloned yet, so "what it will be able to do" belongs
 * to the install, not to the browse. What it can honestly show is who vouched for it, what the nightly scan
 * re-derived at the pinned commit, and where the code is. It shows those and stops. */

const route = useRoute();
const router = useRouter();
const { isOwner } = useRole();
const { entries, registryName, url, token, isOfficial, isLoading, isFetching, error, refetch, useRegistryAt, resetRegistry } = useRegistry();
const { extensions } = useExtensions();
const { add } = useCapabilities();

const query = ref(``);
const mode = ref<`all` | `verified`>(`all`);
const installing = ref<string | undefined>(undefined);
const failure = ref<NoticeModel | undefined>(undefined);

// Below this many rows a filter box is more chrome than the thing it filters — the Extensions tab's threshold
// and its reasoning, applied to a list that will be short for a while yet.
const FILTERABLE_FROM = 6;

const listings = computed<readonly DiscoverListing[]>(() => entries.value.map((entry) => toListing(entry, extensions.value)));
const verifiedCount = computed(() => listings.value.filter((listing) => listing.entry.trust === `verified`).length);

const matches = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return listings.value.filter(
        (listing) => (mode.value === `all` || listing.entry.trust === `verified`) && (needle === `` || listing.search.includes(needle)),
    );
});
const sections = computed(() => listingSections(matches.value));

const listNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined
        ? undefined
        : {
              tone: `danger`,
              title: `Couldn't read that registry.`,
              detail: error.value,
              // A registry that cannot be cloned may simply be a network blip, and re-reading is the whole of
              // the recovery — so the one way out this notice offers is the one that might work.
              action: { label: `Try again`, run: refetch },
          },
);

/* THE LISTING IN THE URL, so a listing can be linked to. The hub's route carries one param and it is the tab,
 * so the listing rides a query — which is a real address either way: a reload reopens the panel, and the link
 * an author pastes into a chat lands their reader on their own extension rather than on a grid to search. */
const openName = computed<string | undefined>(() => (typeof route.query[`ext`] === `string` ? route.query[`ext`] : undefined));
const opened = computed<DiscoverListing | undefined>(() => listings.value.find((listing) => listing.entry.name === openName.value));
const detailOpen = computed({
    get: () => opened.value !== undefined,
    set: (next: boolean) => {
        if (!next) {
            void router.replace({ query: { ...route.query, ext: undefined } });
        }
    },
});
const openListing = (listing: DiscoverListing): void => {
    failure.value = undefined;
    void router.replace({ query: { ...route.query, ext: listing.entry.name } });
};

/* A listing named in the URL that this registry does not carry — a stale link, or a link to somebody else's
 * registry. Cleaned up rather than left as a query param that silently does nothing, but only once the read has
 * actually landed: doing it while the list is still empty would eat every deep link on arrival.
 *
 * IMMEDIATE, because the common case is a warm cache. The registry read is cached hard and persisted, so a link
 * opened in a session that has already browsed arrives with `entries` ALREADY full — nothing changes after
 * mount, and a lazy watcher would never run on precisely the navigations most likely to carry a stale name. */
watch(
    [openName, isLoading, entries],
    ([name, loading, rows]) => {
        if (name !== undefined && !loading && rows.length > 0 && opened.value === undefined) {
            void router.replace({ query: { ...route.query, ext: undefined } });
        }
    },
    { immediate: true },
);

/* INSTALLING FROM HERE IS THE SAME INSTALL, not a shortcut past it. The registry row supplies exactly what the
 * capability form collected — the repository, the commit, the subdirectory, and the tier the daemon's premium
 * gate reads — so nothing is being skipped; there was simply never anything for a person to type that the
 * listing did not already know. The apply streams into a real terminal, which is what the user watches. */
const install = async (listing: DiscoverListing): Promise<void> => {
    const pointer = listing.entry.install;
    if (pointer === undefined || listing.state.action === undefined || installing.value !== undefined) {
        return;
    }
    installing.value = listing.entry.name;
    failure.value = undefined;
    try {
        await add(
            {
                // The capability's id, from the identity the extension is listed under — the same name an
                // update collides with, which is what makes updating an update rather than a second install.
                id: listing.entry.name.replace(/[^a-zA-Z0-9_-]/gu, `-`),
                kind: `extension`,
                config: {
                    url: pointer.url,
                    ...(pointer.ref !== undefined ? { ref: pointer.ref } : {}),
                    ...(pointer.path !== undefined && pointer.path !== `` ? { path: pointer.path } : {}),
                    // Code inside a private registry repo clones with the same token that read the registry.
                    ...(token.value !== `` && pointer.url === url.value.trim() ? { token: token.value } : {}),
                    ...(listing.entry.tier === `premium` ? { tier: `premium` } : {}),
                    // Where this listing lives — what the daemon's update check compares the pinned sha
                    // against afterwards, and where its advisories come from. A hand-typed install on the
                    // Capabilities form records no origin and is rightly compared against the official
                    // registry instead.
                    ...(url.value.trim() !== `` ? { registry: url.value.trim() } : {}),
                },
            },
            (line) => {
                if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                    useTerminalPanel().openFocused(line[`session`]);
                }
            },
        );
        // Installed, but nothing of it is RUNNING until the host runs again — the same convergence the
        // Extensions tab's reload button performs, done here so the extension works without a page reload.
        await reloadExtensions();
        detailOpen.value = false;
    } catch (err) {
        failure.value = noticeFrom(err, `Could not install ${listing.entry.name}.`);
    } finally {
        installing.value = undefined;
    }
};

/* THE READ BEFORE THE RUN. An ordinary chat rather than an isolated unattended turn: the reader is standing
 * here deciding, and the most useful thing about this turn is that they can interrupt it and argue with it.
 * An update asks the sharper question — the installed commit was approved once already, so what is between the
 * two commits is the whole subject — and gets the diff brief instead. */
const audit = (listing: DiscoverListing): void => {
    const pointer = listing.entry.install;
    if (pointer?.ref === undefined) {
        return;
    }
    const shared = { label: listing.entry.name, url: pointer.url, path: pointer.path ?? `` };
    startAgent(
        listing.state.kind === `update` && listing.state.installedRef !== undefined
            ? updateBrief({ ...shared, fromRef: listing.state.installedRef, toRef: pointer.ref })
            : auditBrief({ ...shared, ref: pointer.ref }),
    );
};

// --- the registry behind the list ---
const changing = ref(false);
const draftUrl = ref(``);
const draftToken = ref(``);
const openChange = (): void => {
    draftUrl.value = url.value;
    draftToken.value = token.value;
    changing.value = true;
};
const applyChange = (): void => {
    if (draftUrl.value.trim() === ``) {
        return;
    }
    useRegistryAt(draftUrl.value, draftToken.value);
    changing.value = false;
};
const backToOfficial = (): void => {
    resetRegistry();
    changing.value = false;
};

const clearFilters = (): void => {
    query.value = ``;
    mode.value = `all`;
};

/* What the page says when the sections hold nothing — four different facts, and printing the wrong one is a
 * lie the reader can see. Kept apart from the error notice above: a registry that failed to read has not
 * "listed no extensions", and telling somebody their registry is empty when it is actually unreachable sends
 * them to go and check the wrong thing. */
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || error.value !== undefined || matches.value.length > 0) {
        return undefined;
    }
    if (listings.value.length === 0) {
        return isOfficial.value
            ? `Nothing is published yet. Yours could be the first — see below.`
            : `That registry lists no intentic extensions. It may hold Claude plugins, which install from the Capabilities page.`;
    }
    return mode.value === `verified` && query.value.trim() === ``
        ? `Nothing here has been reviewed yet. Switch to All to see everything published.`
        : `Nothing matches that filter.`;
});
</script>

<template>
    <div class="flex flex-col gap-5">
        <NoticeStack :of="[listNotice]" />

        <!-- SEARCH FIRST. The one control a person arrives wanting, at the top, spanning the grid it narrows —
             and the trust switcher beside it, because "show me only what somebody has actually read" is the
             single most useful narrowing this list has. The switcher is suppressed while nothing is verified:
             a filter that can only ever empty the page is a control that lies about the catalogue. -->
        <div class="flex flex-wrap items-center gap-2">
            <FilterBar v-if="listings.length >= FILTERABLE_FROM" v-model="query" placeholder="Name, publisher, what it does…" :count="matches.length" class="flex-1">
                <template v-if="verifiedCount > 0" #controls>
                    <Segmented
                        v-model="mode"
                        :options="[
                            { label: `All`, value: `all`, badge: listings.length },
                            { label: `Verified`, value: `verified`, badge: verifiedCount },
                        ]"
                    />
                </template>
            </FilterBar>
            <div v-else class="flex-1"></div>
            <button
                type="button"
                :class="cmp.iconButton(`h-8 w-8`)"
                :disabled="isFetching"
                v-tooltip.top="`Re-read the registry`"
                @click="refetch"
            >
                <Icon name="refresh" :spin="isFetching" />
            </button>
        </div>

        <!-- THE SOURCE LINE. Where the list came from, stated rather than asked for — one line, and a way to
             point somewhere else that costs a click instead of standing in front of the catalogue. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
            <span class="text-subtle">Source</span>
            <span class="font-medium text-content">{{ isOfficial ? registryName ?? `Official registry` : registryName ?? url }}</span>
            <span v-if="!isOfficial" class="truncate font-mono text-subtle">{{ url }}</span>
            <button v-if="!changing" type="button" class="text-link hover:underline" @click="openChange">change</button>
            <button v-if="!isOfficial && !changing" type="button" class="text-link hover:underline" @click="backToOfficial">
                back to the official one
            </button>
        </div>

        <!-- Any git repo with a marketplace file is a registry, so a company points this at an internal one and
             this surface never touches intentic.dev again. Folded away by default because that is a decision
             taken once, not a field to walk past every visit. -->
        <div v-if="changing" class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
            <p class="text-2xs text-muted">
                Any git repository holding a <code class="ui-code">.claude-plugin/marketplace.json</code> is a registry — point this at your own and
                nothing here reads ours.
            </p>
            <div class="flex flex-wrap gap-2">
                <input
                    v-model="draftUrl"
                    placeholder="https://github.com/owner/registry"
                    spellcheck="false"
                    :class="cmp.input(`min-w-56 flex-1`)"
                    @keyup.enter="applyChange"
                />
                <input v-model="draftToken" type="password" autocomplete="off" placeholder="Token" :class="cmp.input(`w-32`)" />
                <Button label="Browse" size="small" :disabled="draftUrl.trim() === ``" @click="applyChange" />
                <Button label="Cancel" size="small" text @click="changing = false" />
            </div>
            <p class="text-2xs text-subtle">A token is only needed for a private registry. It's kept for this session and never put in a link.</p>
        </div>

        <div v-if="isLoading" :class="cmp.emptyState(`py-8`)">Reading the registry…</div>

        <!-- THE TWO GROUPS, and their captions. Verified leads because it is the only claim on this page a
             human made; the second heading says what it is NOT, in the same size type, for the same reason. -->
        <div v-for="section in sections" :key="section.id" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-baseline gap-x-2">
                <span :class="cmp.sectionLabel()">{{ section.label }}</span>
                <span class="text-2xs tabular-nums text-subtle">{{ section.listings.length }}</span>
                <span class="text-2xs text-muted">— {{ section.caption }}</span>
            </div>
            <!-- Container queries: how many cards fit is a fact about this pane, which shares the page with the
                 hub's index column and the shell with a chat panel the user drags. -->
            <div class="@container">
                <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3">
                    <DiscoverCard
                        v-for="listing in section.listings"
                        :key="listing.entry.name"
                        :listing="listing"
                        @open="openListing(listing)"
                    />
                </div>
            </div>
        </div>

        <div v-if="emptyNote !== undefined" :class="cmp.emptyState(`flex flex-col items-center gap-2 py-8`)">
            <span>{{ emptyNote }}</span>
            <Button v-if="listings.length > 0" size="small" label="Clear filter" @click="clearFilters" />
        </div>

        <!-- THE OTHER HALF OF SURFACING WHAT PEOPLE BUILD. Until now nothing in this app ever said that
             publishing was possible, let alone that it costs a topic on a repository rather than an account,
             a review queue or a cut. It is a footer rather than a banner because it is for the minority of
             readers who build — but it has to exist SOMEWHERE, and this is the one page where somebody is
             already thinking about other people's extensions. -->
        <!-- One flowing paragraph rather than a row of flex items: the glyph and the two links belong INSIDE the
             sentence, and as siblings of it they each took a line of their own the moment the pane narrowed. -->
        <p class="border-t border-line pt-4 text-2xs leading-relaxed text-muted">
            <Icon name="sparkles" class="mr-1 text-subtle" />
            Built one? Put the <code class="ui-code">intentic-extension</code> topic on its repository and a nightly job opens the listing for you. No
            account, no upload, no queue.
            <a href="https://intentic.dev/docs/extensions/publish/" target="_blank" rel="noreferrer noopener" class="ml-1 text-link hover:underline">
                How publishing works ↗
            </a>
            <a
                v-if="isOfficial"
                :href="OFFICIAL_REGISTRY_URL"
                target="_blank"
                rel="noreferrer noopener"
                class="ml-2 whitespace-nowrap text-link hover:underline"
            >
                The registry ↗
            </a>
        </p>

        <DiscoverDetail
            v-if="opened"
            v-model="detailOpen"
            :listing="opened"
            :can-install="isOwner"
            :installing="installing === opened.entry.name"
            :failure="failure"
            @install="install(opened)"
            @audit="audit(opened)"
        />
    </div>
</template>
