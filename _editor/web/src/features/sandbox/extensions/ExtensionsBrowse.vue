<script setup lang="ts">
import { OFFICIAL_REGISTRY_URL } from "@intentic/registry";
import { Button, ui, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { useExtensions } from "../../extensions/useExtensions";
import { useRegistry } from "../../extensions/useRegistry";
import { useRole } from "../secrets/useRole";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { auditBrief, updateBrief } from "./extensionBrief";
import DiscoverCard from "./DiscoverCard.vue";
import DiscoverDetail from "./DiscoverDetail.vue";
import { type DiscoverListing, listingSections, toListing } from "./discoverListing";

// Browse: what other people have published, the other half of the Extensions section; search, pills and registry line
// are owned by SandboxExtensions.vue and passed in as `query`/`trust`. Shows no manifest, since the code hasn't been
// cloned yet; it states who vouched for it, what the scan found, and where it lives.

const { query, trust } = defineProps<{
    /** The section's search text: matched against name, publisher, description and category. */
    query: string;
    /** The section's trust pills: "show me only what somebody has actually read". */
    trust: `all` | `verified`;
}>();
const emit = defineEmits<{
    /** This half's own failures, raised so the section keeps one notice region above the instrument. */
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

// A registry that fails to read may be a blip; retry is the one recovery this notice can offer.
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

// Encodes the open listing in the URL as a query param beside the `view` pill, so a reload or a pasted link reopens the
// same panel.
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

// Clears a dead `ext` param once the registry has actually loaded, not before, since an empty list would eat every deep
// link on arrival. Immediate, since a warm cache means nothing changes after mount for a lazy watch to catch.
watch(
    [openName, isLoading, entries],
    ([name, loading, rows]) => {
        if (name !== undefined && !loading && rows.length > 0 && opened.value === undefined) {
            void router.replace({ query: { ...route.query, ext: undefined } });
        }
    },
    { immediate: true },
);

// The same install the capability form performs, not a shortcut: the listing already carries everything a person would
// type. Streams into a real terminal for the user to watch.
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
                // Derived from the listing's own name, so a later update collides with this install instead of
                // duplicating it.
                id: listing.entry.name.replace(/[^a-zA-Z0-9_-]/gu, `-`),
                kind: `extension`,
                config: {
                    url: pointer.url,
                    ...(pointer.ref !== undefined ? { ref: pointer.ref } : {}),
                    ...(pointer.path !== undefined && pointer.path !== `` ? { path: pointer.path } : {}),
                    // Code inside a private registry repo clones with the same token that read the registry.
                    ...(token.value !== `` && pointer.url === url.value.trim() ? { token: token.value } : {}),
                    // Where the daemon compares the pinned commit against for updates and advisories; a hand-typed
                    // install records none and falls back to the official registry.
                    ...(url.value.trim() !== `` ? { registry: url.value.trim() } : {}),
                },
            },
            (line) => {
                if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                    useTerminalPanel().openFocused(line[`session`]);
                }
            },
        );
        // Installed but not yet running until the host reconciles; done here so it works without a page reload.
        await reloadExtensions();
        detailOpen.value = false;
    } catch (err) {
        failure.value = noticeFrom(err, `Could not install ${listing.entry.name}.`);
    } finally {
        installing.value = undefined;
    }
};

// An ordinary, interruptible chat, since the reader is deciding right now. An update gets the diff between commits
// instead of a full audit, since the installed one was already approved.
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

// The registry behind the list.
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

// What to say when nothing matches, kept distinct from the error notice: a registry that failed to read has not 'listed
// no extensions'.
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
        <!-- Where the list came from, stated rather than asked for; changing it is one click, not a blocking field. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
            <span class="text-subtle">Source</span>
            <span class="font-medium text-content">{{ isOfficial ? (registryName ?? `Official registry`) : (registryName ?? url) }}</span>
            <span v-if="!isOfficial" class="truncate font-mono text-subtle">{{ url }}</span>
            <button v-if="!changing" type="button" class="text-link hover:underline" @click="openChange">change</button>
            <button v-if="!isOfficial && !changing" type="button" class="text-link hover:underline" @click="backToOfficial">
                back to the official one
            </button>
        </div>

        <!--
            Any git repo with a marketplace file works as a registry; folded by default, since pointing elsewhere is a decision made once, not a
            field to pass every visit.
        -->
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

        <!--
            A registry read is a git clone, the slowest wait in the hub; the skeleton matches the real card grid so it doesn't also look like the
            emptiest view.
        -->
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

        <!-- Verified leads: the one claim on this page a human made. The other heading states what it's not, in the same size. -->
        <div v-for="section in sections" :key="section.id" class="flex flex-col gap-2">
            <div class="flex flex-wrap items-baseline gap-x-2">
                <span :class="ui.sectionLabel()">{{ section.label }}</span>
                <span class="text-2xs tabular-nums text-subtle">{{ section.listings.length }}</span>
                <span v-if="section.caption" class="text-2xs text-muted">{{ section.caption }}</span>
            </div>
            <!-- Container query: how many cards fit depends on this pane's own width, not the viewport. -->
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

        <!--
            The first place this app says publishing is possible, and how cheap it is (a repo topic, no account or queue). A footer, since it's for
            the minority who build, but has to live somewhere.
        -->
        <!-- One flowing paragraph, not flex items: as siblings the glyph and links would each take their own line once the pane narrows. -->
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
