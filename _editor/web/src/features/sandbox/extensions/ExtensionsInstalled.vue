<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary, PendingWorkspaceExtension } from "@intentic/sandbox-contract/schemas/extension-updates";
import { Await, Button, InfoHint, type NoticeModel, Section, ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type ExtensionSection, sectionsOf } from "../../extensions/extensionCategories";
import { hostStateWord } from "../../extensions/extensionState";
import { useExtensionList } from "../../extensions/useExtensionList";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { dismissOperation, useOperations } from "../../../workbench/operations/operations";
import CatalogGrid from "../../../components/catalog/CatalogGrid.vue";
import CatalogSkeleton from "../../../components/catalog/CatalogSkeleton.vue";
import ExtensionCard from "./ExtensionCard.vue";
import ExtensionDetail from "./ExtensionDetail.vue";
import ExtensionRemoveDialog from "./ExtensionRemoveDialog.vue";
import { openEntryOf } from "./extensionRoute";
import ExtensionTile from "./ExtensionTile.vue";
import { extensionBusy, ROWS } from "./extensionWork";
import { useT } from "@intentic/ui/i18n";

// Every extension this sandbox has (first-party, baked, git-installed, workspace), the half of the Extensions section
// answering 'what do I have and is it working' (Browse is the other half). Drawn as Browse draws the registry, so the
// section reads as one catalog: tiles in the catalog grid under section labels (ExtensionTile), each opening its own page
// in the list's place (ExtensionDetail) and keeping its switch. Built to be scanned: the nominal case is silent,
// exceptions pin to a group at the top, and sections group by manifest-declared purpose. What has no page to open
// (waiting for approval, not loadable, running unlisted) is a card as wide as the list, since its words are read whole.

const t = useT();

const { query, mode, publishedMatches, manage } = defineProps<{
    /** The section's search text: matches the id and everything the extension contributes. */
    query: string;
    /** The section's state pills: which of 'I have it on' / 'I switched it off' is asked for. */
    mode: `all` | `on` | `off`;
    /** How many published extensions the same search matches; the section knows, this half doesn't. */
    publishedMatches: number;
    /** Whether this reader may change what is installed; below maintainer the list is read, with nothing to press. */
    manage: boolean;
    /** Whether Browse is offered to this reader, which an empty list points at. */
    browsable: boolean;
}>();
const emit = defineEmits<{
    /** The list's own read failing, raised so the section keeps one notice region above the instrument. */
    notice: [NoticeModel | undefined];
    /** How many rows the section's query left, drawn on the search field. */
    matched: [number];
    /** The reader has nothing installed and is asking where extensions come from: switch to Browse. */
    browse: [];
    /** Their filter matched nothing and they pressed the way out. */
    clear: [];
    /** Whether an extension's page stands where the list was, so the section can put away the list's own instrument. */
    detail: [open: boolean];
}>();

const { entries, invalid, pending: waiting, unlisted, setEnabled, approve, remove, clearDev, loaded, error } = useExtensionList();
// The list query's own message, in the words of the view that asked for it.
watch(
    () => error.value,
    (failure) =>
        emit(
            `notice`,
            failure === undefined
                ? undefined
                : { tone: `danger`, title: t(`sandbox.extensionsInstalled.couldntListSandboxsExtensions`), detail: failure },
        ),
    { immediate: true },
);

// The open extension rides the URL (`?ext=<id>`) beside the `view` pill, so a reload, a pasted link or the browser's Back
// lands on the same page; both opening and the way back push, as Capabilities' tiles do (capabilityRoute.ts). An id
// the list doesn't hold yet leaves the list showing until it does: a just-created extension, or one just installed from
// Browse, opens by itself once its row arrives.
const route = useRoute();
const router = useRouter();
const openId = computed(() => openEntryOf(route.query));
const opened = computed(() => entries.value.find((entry) => entry.extension.id === openId.value));
const openExtension = (id: string): void => {
    void router.push({ query: { ...route.query, ext: id } });
};
const closeExtension = (): void => {
    void router.push({ query: { ...route.query, ext: undefined } });
};
watch(
    () => opened.value !== undefined,
    (open) => emit(`detail`, open),
    { immediate: true },
);

const matches = computed(() => {
    const needle = query.trim().toLowerCase();
    return entries.value.filter(
        (entry) => (mode === `all` || (mode === `on`) === entry.extension.enabled) && (needle === `` || entry.search.includes(needle)),
    );
});
const attention = computed(() => matches.value.filter((entry) => entry.state.attention));
const healthy = computed(() => matches.value.filter((entry) => !entry.state.attention));
watch(
    () => matches.value.length,
    (count) => emit(`matched`, count),
    { immediate: true },
);

// The exception group is an ordinary section, just pinned first, overriding the purpose taxonomy: a broken extension
// shouldn't hide under the heading you'd look for it on a good day.
const sections = computed<ExtensionSection[]>(() => [
    ...(attention.value.length === 0
        ? []
        : [
              {
                  id: `attention`,
                  label: t(`sandbox.words.needsAttention`),
                  entries: attention.value,
              },
          ]),
    ...sectionsOf(healthy.value),
]);
// A group that IS a state heads itself in that state's ink: danger once anything in it failed, else a warning.
const attentionTone = computed(() => (attention.value.some((entry) => entry.state.variant === `danger`) ? `danger` : `warning`));

// Three distinct empty reasons: an attention row still counts as a match, so 'nothing matches' would be visibly false
// while one sits above. Only drawn once the list is read (<Await>), so none of them speaks for a list still on its way.
const emptyNote = computed<string | undefined>(() => {
    if (healthy.value.length > 0) {
        return undefined;
    }
    if (entries.value.length === 0) {
        // The other half of this section, not another page: why Browse is a pill, not a nav row.
        return t(`sandbox.extensionsInstalled.nothingInstalled`);
    }
    if (attention.value.length > 0) {
        return t(`sandbox.extensionsInstalled.nothingElse`);
    }
    return t(`sandbox.extensionsInstalled.nothingMatches`);
});

// The row verbs, kept in the operations ledger under the extension's id (extensionWork.ts) rather than here: switching to
// Browse unmounts this list while the daemon stops, starts or removes what the press asked, and the section's notice
// region (SandboxExtensions) reads how each ended from the ledger. Each answers its own sentence, which is also its
// receipt when it ends with the section closed, or nothing where the tile says it by itself (the switch, which then
// raises none). A press puts the earlier answers away, as the one notice region it speaks in always did.
const rows = useOperations<NoticeModel | undefined>(ROWS);
const verb = async (id: string, what: string, failed: string, task: () => Promise<NoticeModel | undefined>, quiet = false) => {
    for (const operation of rows.all.value) {
        dismissOperation(operation.key);
    }
    return rows.run(id, { what, failed, task, done: (said) => said?.title, quiet });
};

// The daemon has already stopped or started the processes; reloadExtensions activates or retires the row here, without
// a page reload.
const toggle = async (extension: ExtensionSummary, enabled: boolean): Promise<void> => {
    if (extensionBusy(extension.id, extensionIdOf(extension.manifest))) {
        return;
    }
    const manifest = extensionIdOf(extension.manifest);
    await verb(
        extension.id,
        enabled ? t(`sandbox.extensionsInstalled.enabling`, { manifest }) : t(`sandbox.extensionsInstalled.disabling`, { manifest }),
        enabled ? t(`sandbox.extensionsInstalled.couldNotEnable`, { manifest }) : t(`sandbox.extensionsInstalled.couldNotDisable`, { manifest }),
        async () => {
            await setEnabled(extension.id, enabled);
            await reloadExtensions();
            return undefined;
        },
        true,
    );
};

// Back from a source checkout to the pinned copy: the daemon moves its processes and backend, the reload swaps the bundle
// this browser runs. Said afterwards, since the row's dev line simply disappears.
const leaveDev = async (extension: ExtensionSummary): Promise<void> => {
    if (extensionBusy(extension.id, extensionIdOf(extension.manifest))) {
        return;
    }
    const manifest = extensionIdOf(extension.manifest);
    await verb(
        extension.id,
        t(`sandbox.extensionsInstalled.leavingDev`, { manifest }),
        t(`sandbox.extensionsInstalled.couldntLeaveDev`, { manifest }),
        async () => {
            await clearDev(extension.id);
            await reloadExtensions();
            return { tone: `info`, title: t(`sandbox.extensionsInstalled.backToPinned`, { manifest }) };
        },
    );
};

// The yes a workspace extension waits for, given for the powers on screen; the daemon starts what it runs, and the reload
// loads its UI here. The button spins on the ledger, so a list drawn again mid-approval still shows it under way.
const approveExtension = async (extension: PendingWorkspaceExtension): Promise<void> => {
    if (extensionBusy(extension.id)) {
        return;
    }
    await verb(
        extension.id,
        t(`sandbox.extensionsInstalled.approving`, { manifest: extension.id }),
        t(`sandbox.extensionsInstalled.couldntApprove`, { manifest: extension.id }),
        async () => {
            await approve(extension.id, extension.digest);
            await reloadExtensions();
            return { tone: `info`, title: t(`sandbox.extensionsInstalled.approvedNow`, { manifest: extension.id }) };
        },
    );
};

// Removal lives in the ledger rather than on the row: the row is torn down by the refetch that removal causes, so a
// component that unmounts mid-call is the wrong place to hold the call's outcome. The dialog stays up until it lands.
const removing = ref<ExtensionSummary | undefined>(undefined);
const removingNow = computed(() => removing.value !== undefined && rows.at(removing.value.id)?.state === `running`);
const confirmRemove = async (): Promise<void> => {
    const extension = removing.value;
    if (extension === undefined || extensionBusy(extension.id, extensionIdOf(extension.manifest))) {
        return;
    }
    const manifest = extensionIdOf(extension.manifest);
    const ended = await verb(
        extension.id,
        t(`sandbox.extensionsInstalled.removing`, { manifest }),
        t(`sandbox.extensionsInstalled.couldNotRemove`, { manifest }),
        async () => {
            const removed = await remove(extension.id);
            // Retires its views and commands in this browser without a page reload, the same reconcile the switch performs.
            await reloadExtensions();
            // Said plainly and afterwards: the dialog stated the plan, this states what the plan turned out to be. A
            // pending rebuild is a warning rather than a note, since until it runs the image still carries what it baked.
            const said = [
                ...(removed.connections.length === 0
                    ? []
                    : [
                          t(
                              `sandbox.extensionsInstalled.connectionsWent`,
                              { count: removed.connections.length, names: removed.connections.join(`, `) },
                              removed.connections.length,
                          ),
                      ]),
                ...(removed.rebuildNeeded === true ? [t(`sandbox.extensionsInstalled.imageStillHas`)] : []),
            ];
            return {
                tone: removed.rebuildNeeded === true ? `warning` : `info`,
                title: t(`sandbox.extensionsInstalled.removed`, { manifest }),
                ...(said.length === 0 ? {} : { detail: said.join(` `) }),
            };
        },
    );
    if (ended?.state === `done` && removing.value?.id === extension.id) {
        removing.value = undefined;
        // Its page goes with it: back to the list, where the receipt is said.
        if (openId.value === extension.id) {
            closeExtension();
        }
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- A picked extension takes the list's place, as a picked listing does in Browse. -->
        <ExtensionDetail
            v-if="opened"
            :key="opened.extension.id"
            :entry="opened"
            :pending="extensionBusy(opened.extension.id, extensionIdOf(opened.extension.manifest))"
            :manage="manage"
            @toggle="toggle"
            @remove="(extension) => (removing = extension)"
            @dev-clear="leaveDev"
            @back="closeExtension"
        />
        <template v-else>
            <!-- Written in this workspace and not approved in its current shape: nothing of it runs until the yes, so it leads.
                 Why it waits is how the section works, so it is the (i)'s; what a yes allows is on each card, to be read
                 before the press. -->
            <Section v-if="waiting.length > 0" :label="t(`sandbox.extensionsInstalled.waitingForApproval`)" tone="warning">
                <template #info>
                    <InfoHint :label="t(`sandbox.dataProtection.about`, { name: t(`sandbox.extensionsInstalled.waitingForApproval`) })">
                        <span class="text-xs text-content">{{ t(`sandbox.extensionsInstalled.waitingCaption`) }}</span>
                    </InfoHint>
                </template>
                <div class="flex flex-col gap-2">
                    <ExtensionCard
                        v-for="extension in waiting"
                        :key="extension.id"
                        :name="extension.manifest.name"
                        :prefix="extension.manifest.publisher"
                        :line="`.intentic/config/workspace-extensions/${extension.dir}`"
                        :art="extension.manifest.art"
                        :logo="extension.manifest.logo"
                        :icon="extension.manifest.icon"
                    >
                        <template v-if="manage" #control>
                            <Button
                                tier="accent"
                                size="small"
                                :label="t(`sandbox.extensionsInstalled.approve`)"
                                :loading="extensionBusy(extension.id)"
                                @click="approveExtension(extension)"
                            />
                        </template>
                        <!-- The same vocabulary and marks the update card reads out: what a yes allows, and what it no longer asks for. -->
                        <p v-if="extension.powers.added.length === 0" class="text-subtle">
                            {{ t(`sandbox.extensionsInstalled.asksForNothing`) }}
                        </p>
                        <template v-else>
                            <p class="text-muted">
                                {{
                                    extension.approvedBefore
                                        ? t(`sandbox.extensionsInstalled.newPowersSinceApproved`)
                                        : t(`sandbox.extensionsInstalled.whatItAsksFor`)
                                }}
                            </p>
                            <ul class="flex flex-col gap-0.5">
                                <li v-for="power in extension.powers.added" :key="power" class="text-content">+ {{ power }}</li>
                            </ul>
                        </template>
                        <ul v-if="extension.powers.removed.length > 0" class="flex flex-col gap-0.5">
                            <li v-for="power in extension.powers.removed" :key="power" class="text-subtle">− {{ power }}</li>
                        </ul>
                    </ExtensionCard>
                </div>
            </Section>

            <!-- Sections render nothing while the read is out, so the wait takes the list's own shape instead of a sentence: the
                 list as it last looked in this sandbox, or until then a section of placeholder tiles. A failed read says so in
                 the section's notice region (`notice`), so nothing is drawn here for it. -->
            <Await :of="loaded" imprint="sandbox.extensions.installed" :label="t(`sandbox.extensionsInstalled.readingSandboxsExtensions`)">
                <template #fallback>
                    <div role="status" aria-busy="true">
                        <span class="sr-only">{{ t(`sandbox.extensionsInstalled.readingSandboxsExtensions`) }}</span>
                        <!-- The list is grouped by what each extension is for, so the heading is a bar: no group is known yet. -->
                        <Section>
                            <template #label><span class="skeleton block h-2.5 w-32" aria-hidden="true" /></template>
                            <CatalogSkeleton :control="manage" />
                        </Section>
                    </div>
                </template>
                <template #failed />
                <!-- The sections and the empty note as one box (never empty once read: no healthy tile means a note), spaced as
                     the column it sits in. -->
                <div class="flex flex-col gap-6">
                    <!-- The pinned group heads itself in the worst ink it holds, as a group that IS a state does. -->
                    <Section
                        v-for="section in sections"
                        :key="section.id"
                        :label="section.label"
                        :tone="section.id === `attention` ? attentionTone : undefined"
                    >
                        <CatalogGrid>
                            <ExtensionTile
                                v-for="entry in section.entries"
                                :key="entry.extension.id"
                                :data-extension="entry.extension.id"
                                :entry="entry"
                                :pending="extensionBusy(entry.extension.id, extensionIdOf(entry.extension.manifest))"
                                :manage="manage"
                                @toggle="(enabled) => toggle(entry.extension, enabled)"
                                @open="openExtension(entry.extension.id)"
                            />
                        </CatalogGrid>
                    </Section>

                    <div v-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-6`)">
                        <span>{{ emptyNote }}</span>
                        <!-- An empty list is the moment to answer 'where do extensions come from', not just point at another surface. -->
                        <button v-if="browsable && entries.length === 0" type="button" :class="ui.textButton()" @click="emit(`browse`)">
                            {{ t(`sandbox.extensionsInstalled.discoverWhatPeoplePublished`) }}
                        </button>
                        <!-- The empty state answers the active filter before offering reset. -->
                        <button
                            v-if="browsable && matches.length === 0 && publishedMatches > 0"
                            type="button"
                            :class="ui.textButton()"
                            @click="emit(`browse`)"
                        >
                            {{
                                t(`sandbox.extensionsInstalled.publishedMatches`, { count: publishedMatches, query: query.trim() }, publishedMatches)
                            }}
                        </button>
                        <Button
                            tier="boring"
                            v-if="matches.length === 0 && entries.length > 0"
                            size="small"
                            :label="t(`ui.action.clearFilter`)"
                            @click="emit(`clear`)"
                        />
                    </div>
                </div>
            </Await>

            <!-- Unenumerated workspace extensions are listed with their reason, read whole. -->
            <Section v-if="invalid.length > 0" :label="t(`sandbox.extensionsInstalled.notLoadable`)" tone="danger">
                <div class="flex flex-col gap-2">
                    <ExtensionCard
                        v-for="entry in invalid"
                        :key="entry.dir"
                        :name="entry.dir"
                        :line="`.intentic/config/workspace-extensions/${entry.dir}`"
                    >
                        <p class="text-danger">{{ entry.error }}</p>
                    </ExtensionCard>
                </div>
            </Section>

            <!-- Running in this app build, absent from the daemon's list: no page to open, no switch to offer. -->
            <Section v-if="unlisted.length > 0" :label="t(`sandbox.extensionsInstalled.runningNotListed`)" tone="warning">
                <div class="flex flex-col gap-2">
                    <ExtensionCard v-for="status in unlisted" :key="status.id" :name="status.extensionId">
                        <template #line>
                            <span class="first-letter:uppercase" :class="status.state === `error` ? `text-danger` : `text-warning`">{{
                                hostStateWord(status.state)
                            }}</span>
                        </template>
                        <p v-if="status.detail" class="text-warning">{{ status.detail }}</p>
                    </ExtensionCard>
                </div>
            </Section>
        </template>

        <!-- Removal takes state the owner configured themselves, so it is never one click: the dialog reads the plan
             first and names every connection, credential and file that goes with it. -->
        <ExtensionRemoveDialog :extension="removing" :busy="removingNow" @close="removing = undefined" @confirm="void confirmRemove()" />
    </div>
</template>
