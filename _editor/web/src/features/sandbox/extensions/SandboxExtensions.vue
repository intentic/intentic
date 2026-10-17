<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import { Button, ui, FilterBar, type NoticeModel, NoticeStack, SegmentedControl, timeAgo, vAction } from "@intentic/ui";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { storedValue, storeValue } from "../../../app/storage/browserStorage";
import { useExtensionList } from "../../extensions/useExtensionList";
import { useExtensions } from "../../../models/extensions/useExtensions";
import { useRegistry } from "../../extensions/useRegistry";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { dismissOperation, useOperations } from "../../../workbench/operations/operations";
import { toListing, updateCount } from "../../../models/sandbox/discoverListing";
import { endedNotice, ROWS, SECTION } from "./extensionWork";
import ExtensionsBrowse from "./ExtensionsBrowse.vue";
import ExtensionsInstalled from "./ExtensionsInstalled.vue";
import { INSTALLS, type InstallVerb, installNotice, installsInFlight, listingOf } from "./installsInFlight";
import NewExtensionDialog from "./NewExtensionDialog.vue";
import { useT } from "@intentic/ui/i18n";

// The sandbox hub's Extensions section: installed and published listings as two pills over one shared search box.
// The mode rides the URL (`?view=browse|installed`) rather than component state, so a reload or pasted link lands on
// the same view; a bare URL opens the view last picked here, Browse until one has been.

const t = useT();

const VIEWS = [`installed`, `browse`] as const;
type View = (typeof VIEWS)[number];
const isView = (value: unknown): value is View => VIEWS.some((known) => known === value);

// Per browser, not per sandbox: which pill a person reaches for is a habit of theirs, not a fact about the box.
const VIEW_KEY = `intentic.extensionsView`;

const route = useRoute();
const router = useRouter();

const lastPicked = (): View => {
    const stored = storedValue(VIEW_KEY);
    return isView(stored) ? stored : `browse`;
};
const view = computed<View>(() => {
    const asked = route.query[`view`];
    return isView(asked) ? asked : lastPicked();
});
// Switching views drops `ext`: it's Browse's own deep-link state, useless while the installed list is shown.
const show = (next: View): void => {
    storeValue(VIEW_KEY, next);
    void router.replace({ query: { ...route.query, view: next, ext: undefined } });
};

const { entries, create, checkUpdates, updatesCheckedAt, updatedSinceLoaded, installedSinceLoaded } = useExtensionList();
const { extensions } = useExtensions();
// Reads the registry only while Browse is shown; the update count then costs nothing on the installed view.
const { entries: listed, isFetching, refetch } = useRegistry({ read: computed(() => view.value === `browse`) });
const listings = computed(() => listed.value.map((entry) => toListing(entry, extensions.value)));
const updatable = computed(() => updateCount(listings.value));

// Below this many rows a filter box would be more chrome than the list itself; the threshold differs per view.
const FILTERABLE_FROM: Record<View, number> = { installed: 8, browse: 6 };

const query = ref(``);
const mode = ref<`all` | `on` | `off`>(`all`);
const trust = ref<`all` | `verified`>(`all`);
// How many rows the current view's filter left, drawn on the field that did the narrowing.
const matched = ref(0);
// Whichever view is mounted raises its read's failure here, keeping one notice region for the section.
const viewNotice = ref<NoticeModel | undefined>(undefined);

// How many published listings match the query, ignoring the trust pills; zero while the registry cache is cold.
const publishedMatches = computed(() => {
    const needle = query.value.trim().toLowerCase();
    return needle === `` ? 0 : listings.value.filter((listing) => listing.search.includes(needle)).length;
});

const total = computed(() => (view.value === `installed` ? entries.value.length : listings.value.length));
const filterable = computed(() => total.value >= FILTERABLE_FROM[view.value]);
const enabledCount = computed(() => entries.value.filter((entry) => entry.extension.enabled).length);
const verifiedCount = computed(() => listings.value.filter((listing) => listing.entry.trust === `verified`).length);

const clearFilters = (): void => {
    query.value = ``;
    mode.value = `all`;
    trust.value = `all`;
};

// Both counts are inventories; the update count is a mark instead, since it isn't the size of either list.
const viewOptions = computed(() => [
    { label: t(`sandbox.words.installed`), value: `installed` as View, badge: entries.value.length },
    {
        label: t(`ui.action.browse`),
        value: `browse` as View,
        badge: listings.value.length,
        ...(updatable.value > 0
            ? {
                  mark: `arrow-circle-up` as const,
                  markTitle: {
                      title: t(`sandbox.sandboxExtensions.newerCommits`),
                      rows: [{ label: t(`sandbox.sandboxExtensions.updatable`), value: updatable.value }],
                  },
              }
            : {}),
    },
]);

// Work started from this section, kept in the operations ledger rather than here (extensionWork.ts): the section's own
// verbs, the installed rows' and Browse's installs. Whatever ended is said in the notice region until put away, which
// is also how an outcome that ended while the reader was elsewhere waits for them; an install whose dialog is open is
// that dialog's to say.
const section = useOperations<unknown>(SECTION);
const rows = useOperations<NoticeModel | undefined>(ROWS);
const installs = useOperations<InstallVerb>(INSTALLS);

// Re-runs the extension host so a newly installed extension gets picked up, cheaper than a full page reload. Shows
// itself on the button and in the list, so it raises no receipt.
const reloading = computed(() => section.at(`reload`)?.state === `running`);
const reload = async (): Promise<void> => {
    await section.run(`reload`, {
        what: t(`sandbox.sandboxExtensions.reloading`),
        quiet: true,
        failed: t(`sandbox.sandboxExtensions.couldNotReload`),
        task: () => reloadExtensions(),
    });
};

// An update landed elsewhere while this tab still runs the old bundle; the button here is the same host reload,
// shown as a notice rather than auto-reloading since replacing the view mid-use is unwanted. Silent while an install
// from this page is under way: the list hears of it before the host does, and that install reloads the host itself.
const staleNotice = computed<NoticeModel | undefined>(() => {
    if (updatedSinceLoaded.value.length === 0 || installsInFlight.value.size > 0) {
        return undefined;
    }
    const names = updatedSinceLoaded.value.map((extension) => extensionIdOf(extension.manifest)).join(`, `);
    const count = updatedSinceLoaded.value.length;
    const plural = t(`sandbox.sandboxExtensions.wasWere`, count);
    return {
        tone: `info`,
        title: t(`sandbox.sandboxExtensions.reloadToFinishUpdating`),
        detail: t(`sandbox.sandboxExtensions.updatedBrowserStillRunning`, { names, plural }),
        action: { label: t(`sandbox.sandboxExtensions.reloadNow`), run: () => void reload() },
    };
});

// The same for an extension installed or approved elsewhere (an agent's `capabilities add`, another tab): listed now,
// never loaded here. Offered rather than done, for the same reason as above: a reload re-runs every extension.
const newNotice = computed<NoticeModel | undefined>(() => {
    const added = installedSinceLoaded.value;
    if (added.length === 0 || installsInFlight.value.size > 0) {
        return undefined;
    }
    const names = added.map((extension) => extensionIdOf(extension.manifest)).join(`, `);
    return {
        tone: `info`,
        title: t(`sandbox.sandboxExtensions.loadNewlyInstalled`, added.length),
        detail: t(`sandbox.sandboxExtensions.installedSinceLoaded`, { names }, added.length),
        action: { label: t(`sandbox.sandboxExtensions.loadNow`), run: () => void reload() },
    };
});

// States when updates were last checked, re-rendered on every refetch so it stays as fresh as the check: the registry
// round for every installed extension, which the line's own time says once it lands.
const checking = computed(() => section.at(`check`)?.state === `running`);
const checkNow = async (): Promise<void> => {
    await section.run(`check`, {
        what: t(`sandbox.sandboxExtensions.checkingUpdates`),
        quiet: true,
        failed: t(`sandbox.sandboxExtensions.couldNotCheckUpdates`),
        task: () => checkUpdates(),
    });
};

const creating = ref(false);
// The row a newly created extension opens on, passed down to the installed half rather than reached into.
const focused = ref<string | undefined>(undefined);
// Browse's way to an extension it just installed: the Installed pill, opened on that row.
const reveal = (id: string | undefined): void => {
    focused.value = id;
    show(`installed`);
};
// Reloads the extension host so the new extension actually runs, then opens on its row. The wish was already handed to
// an agent by the creation itself (NewExtensionDialog), which runs on whether or not this section is still open.
const created = async (extension: { id: string }): Promise<void> => {
    // Switches to the installed view so the newly created row isn't hidden behind the other pill.
    if (view.value !== `installed`) {
        show(`installed`);
    }
    focused.value = extension.id;
    await reload();
};

const revealInstalled = (key: string, id: string | undefined): void => {
    dismissOperation(key);
    reveal(id);
};
// The open listing's install is said in its dialog, not here.
const openListing = computed(() => (view.value === `browse` && typeof route.query[`ext`] === `string` ? route.query[`ext`] : undefined));
const workNotices = computed<(NoticeModel | undefined)[]>(() => [
    // The dialog says a creation's failure while it is open; closed over one, the section does.
    ...section.all.value.filter((operation) => !(creating.value && operation.key === `${SECTION}/create`)).map((operation) => endedNotice(operation)),
    ...rows.all.value.map((operation) => endedNotice(operation, operation.value)),
    ...installs.all.value
        .filter((operation) => listingOf(operation.key) !== openListing.value)
        .map((operation) => installNotice(operation, extensions.value, (id) => revealInstalled(operation.key, id))),
]);
const dismissWork = (notice: NoticeModel): void => {
    if (notice.key !== undefined) {
        dismissOperation(notice.key);
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Installed and Browse are two lists, so they are tabs, as every page's parts are; the search below is whichever is open's. -->
        <SegmentedControl
            :model-value="view"
            :options="viewOptions"
            variant="underline"
            :aria-label="t(`sandbox.sandboxNav.extensions`)"
            @update:model-value="show"
        />

        <div v-if="viewNotice || staleNotice || newNotice || workNotices.some(Boolean)" class="flex flex-col gap-2">
            <NoticeStack :of="[viewNotice, staleNotice, newNotice]" />
            <NoticeStack :of="workNotices" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="dismissWork" />
        </div>

        <!-- The open tab's instrument: the search box takes the row's slack, filters ride #controls, the verbs end it. -->
        <div class="flex flex-wrap items-center gap-2">
            <FilterBar
                v-if="filterable"
                v-model="query"
                :placeholder="
                    view === `installed` ? t(`sandbox.sandboxExtensions.nameContribution`) : t(`sandbox.sandboxExtensions.namePublisherWhatDoes`)
                "
                :count="matched"
                :aria-label="
                    view === `installed`
                        ? t(`sandbox.sandboxExtensions.filterInstalledExtensions`)
                        : t(`sandbox.sandboxExtensions.searchPublishedExtensions`)
                "
                class="min-w-0 flex-1 basis-64"
            >
                <template v-if="view === `installed`" #controls>
                    <SegmentedControl
                        v-model="mode"
                        :options="[
                            { label: t(`sandbox.words.all`), value: `all`, badge: entries.length },
                            { label: t(`sandbox.sandboxExtensions.on`), value: `on`, badge: enabledCount },
                            { label: t(`sandbox.sandboxExtensions.off`), value: `off`, badge: entries.length - enabledCount },
                        ]"
                    />
                </template>
                <!-- Hidden while nothing is verified: a filter that could only empty the page misrepresents the catalogue. -->
                <template v-else-if="verifiedCount > 0" #controls>
                    <SegmentedControl
                        v-model="trust"
                        :options="[
                            { label: t(`sandbox.words.all`), value: `all`, badge: listings.length },
                            { label: t(`sandbox.words.verified`), value: `verified`, badge: verifiedCount },
                        ]"
                    />
                </template>
            </FilterBar>
            <div v-else class="flex-1"></div>

            <!-- One cluster, so the two verbs wrap together onto the row's next line instead of the refresh stranding on a line of its own. -->
            <div class="ml-auto flex shrink-0 items-center gap-2">
                <!-- A labelled button, not an icon: it creates something, unlike the others which only narrow or refresh. -->
                <template v-if="view === `installed`">
                    <Button :label="t(`sandbox.words.newExtension`)" size="small" @click="creating = true">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `lg` })"
                        :disabled="reloading"
                        v-tooltip.top="t(`sandbox.sandboxExtensions.reloadExtensions`)"
                        v-action="reload"
                    >
                        <Icon name="refresh" :spin="reloading" />
                    </button>
                </template>
                <button
                    v-else
                    type="button"
                    :class="ui.iconButton({ size: `lg` })"
                    :disabled="isFetching"
                    v-tooltip.top="t(`sandbox.sandboxExtensions.refreshRegistry`)"
                    @click="refetch"
                >
                    <Icon name="refresh" :spin="isFetching" />
                </button>
            </div>
        </div>

        <NewExtensionDialog v-model="creating" :create="create" @created="created" />

        <ExtensionsInstalled
            v-if="view === `installed`"
            :query="query"
            :mode="mode"
            :focus="focused"
            :published-matches="publishedMatches"
            @notice="viewNotice = $event"
            @matched="matched = $event"
            @browse="show(`browse`)"
            @clear="clearFilters"
        />
        <ExtensionsBrowse
            v-else
            :query="query"
            :trust="trust"
            @notice="viewNotice = $event"
            @matched="matched = $event"
            @clear="clearFilters"
            @reveal="reveal"
        />

        <!-- How many installed extensions have a newer commit and when that was checked; absent until first check runs. -->
        <p v-if="updatesCheckedAt !== undefined" class="text-right text-2xs text-subtle">
            <template v-if="updatable > 0">
                <button v-if="view === `installed`" type="button" :class="ui.textButton({ size: `xs` })" @click="show(`browse`)">
                    {{ t(`sandbox.sandboxExtensions.updatesToInstall`, { count: updatable }, updatable) }}
                </button>
                <span v-else class="text-content">{{ t(`sandbox.sandboxExtensions.updatesToInstall`, { count: updatable }, updatable) }}</span>
                ·
            </template>
            {{ t(`sandbox.sandboxExtensions.updatesChecked`) }} {{ timeAgo(Date.parse(updatesCheckedAt)) }} ·
            <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="checking" v-action="checkNow">
                {{ checking ? t(`sandbox.sandboxExtensions.checking`) : t(`sandbox.sandboxExtensions.checkNow`) }}
            </button>
        </p>
    </div>
</template>
