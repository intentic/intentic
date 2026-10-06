<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { OFFICIAL_REGISTRY_URL } from "@intentic/registry";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { Button, SkeletonSnapshot, ui, type NoticeModel, vSkeletonSource } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { startAgent } from "../../agents/fleet/agentActions";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { useExtensions } from "../../extensions/useExtensions";
import { useRegistry } from "../../extensions/useRegistry";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useTerminalPanel } from "../../terminal/useTerminalPanel";
import { useHubWork } from "../../../workbench/hub/hubWork";
import { extensionStatuses } from "../../../extension-host/loader";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { auditBrief, updateBrief } from "./extensionBrief";
import DiscoverCard from "./DiscoverCard.vue";
import DiscoverDetail from "./DiscoverDetail.vue";
import { type DiscoverListing, type InstallOutcome, listingSections, toListing } from "./discoverListing";
import { beginInstall, installsInFlight } from "./installsInFlight";
import { useT } from "@intentic/ui/i18n";

// Browse: what other people have published, the other half of the Extensions section; search, pills and registry line
// are owned by SandboxExtensions.vue and passed in as `query`/`trust`. Shows no manifest, since the code hasn't been
// cloned yet; it states who vouched for it, what the scan found, and where it lives.

const t = useT();

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
    /** Show this installed extension (by its id, when the list has it) on the Installed pill. */
    reveal: [id: string | undefined];
}>();

const route = useRoute();
const router = useRouter();
const { canShip: canOperate } = useRole();
const { entries, registryName, url, token, isOfficial, isLoading, error, refetch, useRegistryAt, resetRegistry } = useRegistry();
const outline = useSandboxOutline(isLoading);
const { extensions, applyUpdate } = useExtensions();
const { add } = useCapabilities();
const hubWork = useHubWork();

const failure = ref<NoticeModel | undefined>(undefined);
// What the last install or update from the open dialog came to; the dialog turns into its receipt.
const outcome = ref<(InstallOutcome & { readonly name: string }) | undefined>(undefined);

const listings = computed<readonly DiscoverListing[]>(() => entries.value.map((entry) => toListing(entry, extensions.value)));
// What a listing is installed as here, found by identity: a hand-installed copy may carry another id than the listing
// would derive.
const installedAs = (listing: DiscoverListing): ExtensionSummary | undefined =>
    extensions.value.find((extension) => extensionIdOf(extension.manifest) === listing.entry.name);

const matches = computed(() => {
    const needle = query.trim().toLowerCase();
    return listings.value.filter(
        (listing) => (trust === `all` || listing.entry.trust === `verified`) && (needle === `` || listing.search.includes(needle)),
    );
});
const sections = computed(() => listingSections(matches.value));
watch(
    () => matches.value.length,
    (count) => emit(`matched`, count),
    { immediate: true },
);

// A registry that fails to read may be a blip; retry is the one recovery this notice can offer.
watch(
    () => error.value,
    (failed) =>
        emit(
            `notice`,
            failed === undefined
                ? undefined
                : {
                      tone: `danger`,
                      title: t(`sandbox.extensionsBrowse.couldntReadRegistry`),
                      detail: failed,
                      action: { label: t(`ui.action.tryAgain`), run: refetch },
                  },
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
    outcome.value = undefined;
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
const addFromListing = async (listing: DiscoverListing, pointer: NonNullable<DiscoverListing["entry"]["install"]>): Promise<void> => {
    await add(
        {
            // Derived from the listing's own name. An update never comes here (it targets the id it is installed
            // under), so a hand-installed copy named otherwise is not duplicated.
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
};

// What an install came to once the host has reconciled, read off the refreshed list and this browser's load record: a
// switch left off survives an update, and a bundle that threw in activate() is installed all the same.
const NOT_STARTED = new Set([`error`, `incompatible`, `missing`]);
const outcomeOf = (listing: DiscoverListing, verb: InstallOutcome["verb"]): InstallOutcome => {
    const here = installedAs(listing);
    const status = here === undefined ? undefined : extensionStatuses.value.find((loaded) => loaded.id === here.id);
    return {
        verb,
        id: here?.id,
        problem: status !== undefined && NOT_STARTED.has(status.state) ? (status.detail ?? status.state) : undefined,
        off: here?.enabled === false,
        settings: (here?.manifest.contributes?.settings ?? []).length > 0,
    };
};

// Said where the reader is: the dialog they pressed Install in, or, when they closed it while the clone ran, the
// section's notice region, since a receipt nobody can see is how a finished install reads as a stuck one.
const report = (listing: DiscoverListing, verb: InstallOutcome["verb"]): void => {
    const done = outcomeOf(listing, verb);
    if (openName.value === listing.entry.name) {
        outcome.value = { ...done, name: listing.entry.name };
        return;
    }
    const name = listing.entry.name;
    const action = { label: t(`sandbox.discoverDetail.showInInstalled`), run: () => emit(`reveal`, done.id) };
    if (done.problem === undefined) {
        const title =
            verb === `install` ? t(`sandbox.extensionsBrowse.installedName`, { name }) : t(`sandbox.extensionsBrowse.updatedName`, { name });
        emit(`notice`, { tone: `info`, title, action });
        return;
    }
    const title =
        verb === `install`
            ? t(`sandbox.extensionsBrowse.installedNotStartedName`, { name })
            : t(`sandbox.extensionsBrowse.updatedNotStartedName`, { name });
    emit(`notice`, { tone: `warning`, title, detail: done.problem, action });
};

// An update is the Installed tab's update verb, on the id the extension is installed under: it keeps that install's
// token and registry, sets the old checkout aside for revert, and clears the recorded offer. The pinned sha names the
// code, so the install's own repo serves it.
const install = async (listing: DiscoverListing): Promise<void> => {
    const pointer = listing.entry.install;
    // One at a time per listing: the daemon takes one add per id anyway, and a second press would only queue a clone
    // of what is already arriving.
    if (pointer === undefined || listing.state.action === undefined || installsInFlight.value.has(listing.entry.name)) {
        return;
    }
    const endInstall = beginInstall(listing.entry.name);
    failure.value = undefined;
    outcome.value = undefined;
    const { ref: pinned } = pointer;
    const updateOf = listing.state.kind === `update` && pinned !== undefined ? listing.state.installedId : undefined;
    const verb = updateOf === undefined ? `install` : `update`;
    // A clone and an install out in the sandbox: minutes on a big extension, and the terminal it streams to is
    // somewhere else entirely, so the row it was started from carries it.
    const endMark = hubWork.begin(
        updateOf === undefined
            ? t(`sandbox.extensionsBrowse.installing`, { name: listing.entry.name })
            : t(`sandbox.extensionsBrowse.updating`, { name: listing.entry.name }),
    );
    try {
        // Both refresh the extension list on the way out, so the card and the Installed pill already say so.
        await (updateOf !== undefined && pinned !== undefined ? applyUpdate(updateOf, pinned) : addFromListing(listing, pointer));
        // Installed but not yet running until the host reconciles; done here so it works without a page reload.
        await reloadExtensions();
        report(listing, verb);
    } catch (err) {
        const said = noticeFrom(
            err,
            verb === `install`
                ? t(`sandbox.extensionsBrowse.couldNotInstall`, { name: listing.entry.name })
                : t(`sandbox.extensionsBrowse.couldNotUpdate`, { name: listing.entry.name }),
        );
        if (openName.value === listing.entry.name) {
            failure.value = said;
        } else {
            emit(`notice`, said);
        }
    } finally {
        endInstall();
        endMark();
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
        return isOfficial.value ? t(`sandbox.extensionsBrowse.nothingPublished`) : t(`sandbox.extensionsBrowse.registryListsNone`);
    }
    return trust === `verified` && query.trim() === `` ? t(`sandbox.extensionsBrowse.nothingReviewed`) : t(`sandbox.extensionsBrowse.nothingMatches`);
});
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Where the list came from, stated rather than asked for; changing it is one click, not a blocking field. -->
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
            <span class="text-subtle">{{ t(`sandbox.words.source`) }}</span>
            <span class="font-medium text-content">{{
                isOfficial ? (registryName ?? t(`sandbox.extensionsBrowse.officialRegistry`)) : (registryName ?? url)
            }}</span>
            <span v-if="!isOfficial" class="truncate font-mono text-subtle">{{ url }}</span>
            <button v-if="!changing" type="button" class="text-link hover:underline" @click="openChange">
                {{ t(`sandbox.extensionsBrowse.change`) }}
            </button>
            <button v-if="!isOfficial && !changing" type="button" class="text-link hover:underline" @click="backToOfficial">
                {{ t(`sandbox.extensionsBrowse.backToOfficialOne`) }}
            </button>
        </div>

        <!-- Any git repository with a marketplace file can be a collapsed registry. -->
        <div v-if="changing" class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
            <p class="text-2xs text-muted">
                {{ t(`sandbox.extensionsBrowse.anyGitRepositoryHolding`) }} <code class="ui-code">.claude-plugin/marketplace.json</code>
                {{ t(`sandbox.extensionsBrowse.registryPointAtOwn`) }}
            </p>
            <div class="flex flex-wrap gap-2">
                <input
                    v-model="draftUrl"
                    placeholder="https://github.com/owner/registry"
                    spellcheck="false"
                    :class="ui.input(`min-w-56 flex-1`)"
                    @keyup.enter="applyChange"
                />
                <input v-model="draftToken" type="password" autocomplete="off" :placeholder="t(`shared.token`)" :class="ui.input(`w-32`)" />
                <Button :label="t(`ui.action.browse`)" size="small" :disabled="draftUrl.trim() === ``" @click="applyChange" />
                <Button :label="t(`ui.action.cancel`)" size="small" text @click="changing = false" />
            </div>
            <p class="text-2xs text-subtle">{{ t(`sandbox.extensionsBrowse.tokenOnlyNeededPrivate`) }}</p>
        </div>

        <!-- Registry loading draws the listing as it last looked here; until it has been seen once, the real card grid shape. -->
        <SkeletonSnapshot v-if="isLoading && outline" of="sandbox.extensions.browse" :label="t(`sandbox.extensionsBrowse.readingRegistry`)">
            <div class="@container" role="status" aria-busy="true">
                <span class="sr-only">{{ t(`sandbox.extensionsBrowse.readingRegistry`) }}</span>
                <div class="grid grid-cols-1 gap-2 @xl:grid-cols-2 @4xl:grid-cols-3" aria-hidden="true">
                    <div v-for="card in 6" :key="card" class="flex flex-col gap-2 rounded-lg bg-card shadow-sm px-3 py-2.5">
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
        </SkeletonSnapshot>

        <!-- The sections and the empty note as one box, so the next wait draws whichever was last on screen; only drawn
             with something in it, or its gap would open a hole while the registry reads. -->
        <div v-if="sections.length > 0 || emptyNote !== undefined" v-skeleton-source="`sandbox.extensions.browse`" class="flex flex-col gap-6">
            <!-- Verified leads: the one claim on this page a human made. The other heading states what it's not, in the same size. -->
            <div v-for="section in sections" :key="section.id" class="flex flex-col gap-2">
                <div class="flex flex-wrap items-baseline gap-x-2">
                    <span :class="ui.sectionLabel()">{{ section.label }}</span>
                    <span v-if="section.caption" class="text-2xs text-muted">{{ section.caption }}</span>
                </div>
                <!-- Container query: how many cards fit depends on this pane's own width, not the viewport. -->
                <div class="@container">
                    <div class="grid grid-cols-1 gap-3 @xl:grid-cols-2 @xl:gap-4 @4xl:grid-cols-3">
                        <DiscoverCard
                            v-for="listing in section.listings"
                            :key="listing.entry.name"
                            :listing="listing"
                            :installing="installsInFlight.has(listing.entry.name)"
                            @open="openListing(listing)"
                        />
                    </div>
                </div>
            </div>

            <div v-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-8`)">
                <span>{{ emptyNote }}</span>
                <Button v-if="listings.length > 0" size="small" :label="t(`ui.action.clearFilter`)" @click="emit(`clear`)" />
            </div>
        </div>

        <!-- The first place this app says publishing is possible, and how cheap it is (a repo topic, no account or queue). -->
        <!-- Registry details flow as one paragraph so narrow panes wrap naturally. -->
        <p class="text-2xs leading-relaxed text-muted">
            <Icon name="sparkles" class="mr-1 text-subtle" />
            {{ t(`sandbox.extensionsBrowse.builtOnePut`) }} <code class="ui-code">intentic-extension</code>
            {{ t(`sandbox.extensionsBrowse.topicOnRepositoryNightly`) }}
            <a href="https://intentic.dev/docs/extensions/publish/" target="_blank" rel="noreferrer noopener" class="ml-1 text-link hover:underline">
                {{ t(`sandbox.extensionsBrowse.howPublishingWorks`) }}
            </a>
            <a
                v-if="isOfficial"
                :href="OFFICIAL_REGISTRY_URL"
                target="_blank"
                rel="noreferrer noopener"
                class="ml-2 whitespace-nowrap text-link hover:underline"
            >
                {{ t(`sandbox.extensionsBrowse.registry`) }}
            </a>
        </p>

        <!-- Keyed by listing, so an acknowledgment given for one extension never carries over to the next. -->
        <DiscoverDetail
            v-if="opened"
            :key="opened.entry.name"
            v-model="detailOpen"
            :listing="opened"
            :can-install="canOperate"
            :installing="installsInFlight.has(opened.entry.name)"
            :failure="failure"
            :outcome="outcome?.name === opened.entry.name ? outcome : undefined"
            @install="install(opened)"
            @audit="audit(opened)"
            @reveal="emit(`reveal`, installedAs(opened)?.id)"
        />
    </div>
</template>
