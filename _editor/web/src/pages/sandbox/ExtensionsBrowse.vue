<script setup lang="ts">
import { OFFICIAL_REGISTRY_URL } from "@intentic/registry";
import { Button, ui, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../composables/agents/agentActions";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { useExtensions } from "../../composables/extensions/useExtensions";
import { useRegistry } from "../../composables/extensions/useRegistry";
import { useMembership } from "../../composables/membership/useMembership";
import { useRole } from "../../composables/sandbox/useRole";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { useTerminalPanel } from "../../composables/terminal/useTerminalPanel";
import { reloadExtensions } from "../../extension-host/useExtensionHost";
import { auditBrief, updateBrief } from "./extensionBrief";
import DiscoverCard from "./DiscoverCard.vue";
import DiscoverDetail from "./DiscoverDetail.vue";
import { type DiscoverListing, listingSections, toListing } from "./discoverListing";

/* BROWSE: what other people have published, in the one place in this app that already means "extensions".
 *
 * The other half of the Extensions section. Finding one, installing it, managing it and switching it off are
 * one subject, so they are one section with two pills rather than two rows in the hub's index: the search box
 * above is shared, which is what makes "I don't have it" and "somebody published it" the same gesture. The
 * pills, the search text and the registry's freshness line belong to the section (SandboxExtensions.vue) and
 * reach this component as `query` / `trust`.
 *
 * Browsing a registry used to be buried five clicks deep inside an optional block on a form on the
 * Capabilities page, presented as a way to PRE-FILL A TEXT FIELD. Three things were wrong with that and all
 * three are what this file is shaped by.
 *
 *  1. A URL FIELD STOOD WHERE A SEARCH BOX BELONGS. The first thing the old surface asked for was the address
 *     of the registry: a reader who wanted to see what exists was asked to supply the thing that would show
 *     them. Here the list is already on screen (the official registry is the default read, not a default
 *     value in a box), the search box is the first control, and the registry is a source LINE with a way to
 *     change it. "Registries are plural" stays exactly as true; it stops being a toll.
 *  2. VERIFICATION WAS A GLYPH IN A SCROLLBOX. The automated gate and optional human source read are distinct
 *     claims about one exact commit. The first is now required for official admission; the second still leads
 *     the catalogue and is stated without dressing an agent verdict up as human review.
 *  3. THERE WAS NOWHERE TO LEARN ANYTHING. A row was a truncated line and a click filled in a form. A stranger's
 *     extension needs a panel: what it is, whose it is, what is guaranteed and by whom, and the one thing this
 *     product can offer that a marketplace cannot: the reader's own agent, reading that exact commit before a
 *     single line of it runs.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT DO is claim more than it knows. It has no manifest to render: the
 * whole point of a listing is that the code has not been cloned yet, so "what it will be able to do" belongs
 * to the install, not to the browse. What it can honestly show is who vouched for it, what the nightly scan
 * re-derived at the pinned commit, and where the code is. It shows those and stops. */

const { query, trust } = defineProps<{
    /** The section's search text: matched against name, publisher, description and category. */
    query: string;
    /** The section's trust pills: "show me only what somebody has actually read". */
    trust: `all` | `verified`;
}>();
const emit = defineEmits<{
    /** This half's own failures, raised so the section keeps ONE notice region above the instrument. */
    notice: [NoticeModel | undefined];
    /** How many listings the section's query left, drawn on the search field. */
    matched: [number];
    /** Their filter matched nothing and they pressed the way out. */
    clear: [];
}>();

const route = useRoute();
const router = useRouter();
const { canShip: canOperate } = useRole();
const { entries, registryName, url, token, isOfficial, isLoading, error, refetch, useRegistryAt, resetRegistry } = useRegistry();
const outline = useSandboxOutline(isLoading);
const { extensions } = useExtensions();
const { add } = useCapabilities();
// Re-read the credit balance the moment a premium install has spent from it: see the install handler.
const { spent } = useMembership();

const installing = ref<string | undefined>(undefined);
const failure = ref<NoticeModel | undefined>(undefined);

const listings = computed<readonly DiscoverListing[]>(() => entries.value.map((entry) => toListing(entry, extensions.value)));

const matches = computed(() => {
    const needle = query.trim().toLowerCase();
    return listings.value.filter(
        (listing) => (trust === `all` || listing.entry.trust === `verified`) && (needle === `` || listing.search.includes(needle)),
    );
});
const sections = computed(() => listingSections(matches.value));
watch(() => matches.value.length, (count) => emit(`matched`, count), { immediate: true });

/* A registry that cannot be cloned may simply be a network blip, and re-reading is the whole of the recovery,
 * so the one way out this notice offers is the one that might work. */
watch(
    () => error.value,
    (failed) =>
        emit(
            `notice`,
            failed === undefined
                ? undefined
                : { tone: `danger`, title: `Couldn't read that registry.`, detail: failed, action: { label: `Try again`, run: refetch } },
        ),
    { immediate: true },
);

/* THE LISTING IN THE URL, so a listing can be linked to. The hub's route carries one param and it is the
 * section, so the listing rides a query beside the `view` pill, which is a real address either way: a reload
 * reopens the panel, and the link an author pastes into a chat lands their reader on their own extension
 * rather than on a grid to search. */
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

/* A listing named in the URL that this registry does not carry: a stale link, or a link to somebody else's
 * registry. Cleaned up rather than left as a query param that silently does nothing, but only once the read has
 * actually landed: doing it while the list is still empty would eat every deep link on arrival.
 *
 * IMMEDIATE, because the common case is a warm cache. The registry read is cached hard and persisted, so a link
 * opened in a session that has already browsed arrives with `entries` ALREADY full: nothing changes after
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
 * capability form collected: the repository, the commit, the subdirectory, and the tier the daemon's premium
 * gate reads, so nothing is being skipped; there was simply never anything for a person to type that the
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
                // The capability's id, from the identity the extension is listed under: the same name an
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
                    // Where this listing lives: what the daemon's update check compares the pinned sha
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
        // Installed, but nothing of it is RUNNING until the host runs again: the same convergence the section's
        // reload button performs, done here so the extension works without a page reload.
        await reloadExtensions();
        /* A premium install has just spent credits, so every surface showing a balance is now wrong by exactly
         * the donation: the account menu, this catalogue's next cost block, the composer's pill. Re-read once
         * here rather than letting each of them discover it on its own timer: the number the reader will look at
         * to check what just happened is the one that must not be the pre-spend figure. Cheap and unconditional
         * for a premium row, including the reinstall the platform charged nothing for: "nothing changed" is a
         * perfectly good answer to arrive at from the platform rather than to assume. */
        if (listing.entry.tier === `premium`) {
            await spent();
        }
        detailOpen.value = false;
    } catch (err) {
        failure.value = noticeFrom(err, `Could not install ${listing.entry.name}.`);
    } finally {
        installing.value = undefined;
    }
};

/* THE READ BEFORE THE RUN. An ordinary chat rather than an isolated unattended turn: the reader is standing
 * here deciding, and the most useful thing about this turn is that they can interrupt it and argue with it.
 * An update asks the sharper question: the installed commit was approved once already, so what is between the
 * two commits is the whole subject, and gets the diff brief instead. */
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

/* What this half says when the sections hold nothing: four different facts, and printing the wrong one is a
 * lie the reader can see. Kept apart from the error notice above: a registry that failed to read has not
 * "listed no extensions", and telling somebody their registry is empty when it is actually unreachable sends
 * them to go and check the wrong thing. */
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || error.value !== undefined || matches.value.length > 0) {
        return undefined;
    }
    if (listings.value.length === 0) {
        return isOfficial.value
            ? `Nothing is published yet. Yours could be the first: see below.`
            : `That registry lists no intentic extensions. It may hold Claude plugins, which install from the Capabilities page.`;
    }
    return trust === `verified` && query.trim() === ``
        ? `Nothing here has been reviewed yet. Switch to All to see everything published.`
        : `Nothing matches that filter.`;
});
</script>

<template>
    <div class="flex flex-col gap-5">
        <!-- THE SOURCE LINE. Where the list came from, stated rather than asked for: one line, and a way to
             point somewhere else that costs a click instead of standing in front of the catalogue. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
            <span class="text-subtle">Source</span>
            <span class="font-medium text-content">{{ isOfficial ? (registryName ?? `Official registry`) : (registryName ?? url) }}</span>
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
                Any git repository holding a <code class="ui-code">.claude-plugin/marketplace.json</code> is a registry: point this at your own and
                nothing here reads ours.
            </p>
            <div class="flex flex-wrap gap-2">
                <input
                    v-model="draftUrl"
                    placeholder="https://github.com/owner/registry"
                    spellcheck="false"
                    :class="ui.input(`min-w-56 flex-1`)"
                    @keyup.enter="applyChange"
                />
                <input v-model="draftToken" type="password" autocomplete="off" placeholder="Token" :class="ui.input(`w-32`)" />
                <Button label="Browse" size="small" :disabled="draftUrl.trim() === ``" @click="applyChange" />
                <Button label="Cancel" size="small" text @click="changing = false" />
            </div>
            <p class="text-2xs text-subtle">A token is only needed for a private registry. It's kept for this session and never put in a link.</p>
        </div>

        <!-- A registry read is a git clone, so this is the longest wait in the hub and the one most worth
             drawing. The outline is the CARD GRID at the same breakpoints, because that is what makes the
             catalogue recognisable before a single name has landed: a centred sentence in an empty pane made
             the slowest view also look like the emptiest. -->
        <div v-if="isLoading && outline" class="@container" role="status" aria-busy="true">
            <span class="sr-only">Reading the registry…</span>
            <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3" aria-hidden="true">
                <div v-for="card in 6" :key="card" class="flex flex-col gap-2 rounded-lg border border-line bg-card px-3 py-2.5">
                    <div class="flex w-full items-start gap-2.5">
                        <span class="skeleton block h-7 w-7 shrink-0 rounded-md" />
                        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                            <span class="skeleton block h-3.5" :class="[`w-28`, `w-36`, `w-24`][card % 3]" />
                            <span class="skeleton block h-2 w-20" />
                        </div>
                    </div>
                    <span class="skeleton block h-2.5 w-full" />
                    <span class="skeleton block h-2.5 w-3/5" />
                </div>
            </div>
        </div>

        <!-- THE TWO GROUPS, and their captions. Verified leads because it is the only claim on this page a
             human made; the second heading says what it is NOT, in the same size type, for the same reason. -->
        <div v-for="section in sections" :key="section.id" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-baseline gap-x-2">
                <span :class="ui.sectionLabel()">{{ section.label }}</span>
                <span class="text-2xs tabular-nums text-subtle">{{ section.listings.length }}</span>
                <span v-if="section.caption" class="text-2xs text-muted">{{ section.caption }}</span>
            </div>
            <!-- Container queries: how many cards fit is a fact about this pane, which shares the page with the
                 hub's index column and the shell with a chat panel the user drags. -->
            <div class="@container">
                <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2 @xl:gap-4 @4xl:grid-cols-3">
                    <DiscoverCard v-for="listing in section.listings" :key="listing.entry.name" :listing="listing" @open="openListing(listing)" />
                </div>
            </div>
        </div>

        <div v-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-8`)">
            <span>{{ emptyNote }}</span>
            <Button v-if="listings.length > 0" size="small" label="Clear filter" @click="emit(`clear`)" />
        </div>

        <!-- THE OTHER HALF OF SURFACING WHAT PEOPLE BUILD. Until now nothing in this app ever said that
             publishing was possible, let alone that it costs a topic on a repository rather than an account,
             a review queue or a cut. It is a footer rather than a banner because it is for the minority of
             readers who build, but it has to exist SOMEWHERE, and this is the one surface where somebody is
             already thinking about other people's extensions. -->
        <!-- One flowing paragraph rather than a row of flex items: the glyph and the two links belong INSIDE the
             sentence, and as siblings of it they each took a line of their own the moment the pane narrowed. -->
        <p class="text-2xs leading-relaxed text-muted">
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
            :can-install="canOperate"
            :installing="installing === opened.entry.name"
            :failure="failure"
            @install="install(opened)"
            @audit="audit(opened)"
        />
    </div>
</template>
