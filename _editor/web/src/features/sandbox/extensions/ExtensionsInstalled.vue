<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary, PendingWorkspaceExtension } from "@intentic/sandbox-contract/schemas/extension-updates";
import { Button, ui, type NoticeModel, Row, RowGroup, SkeletonRows, SkeletonSnapshot, StatusBadge, vSkeletonSource } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type ExtensionSection, sectionsOf } from "../../extensions/extensionCategories";
import { hostStateWord } from "../../extensions/extensionState";
import { useExtensionList } from "../../extensions/useExtensionList";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { reloadExtensions } from "../../../extension-host/useExtensionHost";
import { dismissOperation, useOperations } from "../../../workbench/operations/operations";
import ExtensionDetail from "./ExtensionDetail.vue";
import ExtensionRemoveDialog from "./ExtensionRemoveDialog.vue";
import { openEntryOf } from "./extensionRoute";
import ExtensionRow from "./ExtensionRow.vue";
import { extensionBusy, ROWS } from "./extensionWork";
import { useT } from "@intentic/ui/i18n";

// Every extension this sandbox has (first-party, baked, git-installed, workspace), the half of the Extensions section
// answering 'what do I have and is it working' (Browse is the other half). Drawn as Capabilities draws what is already
// connected: rows grouped under section labels, each opening its own page in the list's place (ExtensionDetail). Built
// to be scanned: the nominal case is silent, exceptions pin to a group at the top, and sections group by
// manifest-declared purpose.

const t = useT();

const { query, mode, publishedMatches } = defineProps<{
    /** The section's search text: matches the id and everything the extension contributes. */
    query: string;
    /** The section's state pills: which of 'I have it on' / 'I switched it off' is asked for. */
    mode: `all` | `on` | `off`;
    /** How many published extensions the same search matches; the section knows, this half doesn't. */
    publishedMatches: number;
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

const { entries, invalid, pending: waiting, unlisted, setEnabled, approve, remove, clearDev, isLoading, error } = useExtensionList();
const outline = useSandboxOutline(isLoading);
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

// Three distinct empty reasons: an attention row still counts as a match, so 'nothing matches' would be visibly false
// while one sits above.
const emptyNote = computed<string | undefined>(() => {
    if (isLoading.value || healthy.value.length > 0) {
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
// receipt when it ends with the section closed, or nothing where the row says it by itself (the switch, which then
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
        <!-- A picked extension takes the list's place, as a picked connection does in Capabilities. -->
        <ExtensionDetail
            v-if="opened"
            :key="opened.extension.id"
            :entry="opened"
            :pending="extensionBusy(opened.extension.id, extensionIdOf(opened.extension.manifest))"
            @toggle="toggle"
            @remove="(extension) => (removing = extension)"
            @dev-clear="leaveDev"
            @back="closeExtension"
        />
        <template v-else>
            <!-- Written in this workspace and not approved in its current shape: nothing of it runs until the yes, so it leads. -->
            <RowGroup
                v-if="waiting.length > 0"
                :label="t(`sandbox.extensionsInstalled.waitingForApproval`)"
                :caption="t(`sandbox.extensionsInstalled.waitingCaption`)"
            >
                <Row v-for="extension in waiting" :key="extension.id">
                    <template #title>
                        <span class="block truncate">{{ extension.id }}</span>
                    </template>
                    <template #description>
                        <span class="block truncate">.intentic/config/workspace-extensions/{{ extension.dir }}</span>
                    </template>
                    <template #meta><StatusBadge variant="warning" :label="t(`sandbox.extensionsInstalled.pendingBadge`)" size="xs" /></template>
                    <template #control>
                        <Button
                            size="small"
                            :label="t(`sandbox.extensionsInstalled.approve`)"
                            :loading="extensionBusy(extension.id)"
                            @click="approveExtension(extension)"
                        />
                    </template>
                    <!-- The same vocabulary and marks the update card reads out: what a yes allows, and what it no longer asks for. -->
                    <template #below>
                        <div class="flex flex-col gap-1 pb-2">
                            <p v-if="extension.powers.added.length === 0" class="text-2xs text-subtle">
                                {{ t(`sandbox.extensionsInstalled.asksForNothing`) }}
                            </p>
                            <template v-else>
                                <p class="text-2xs text-muted">
                                    {{
                                        extension.approvedBefore
                                            ? t(`sandbox.extensionsInstalled.newPowersSinceApproved`)
                                            : t(`sandbox.extensionsInstalled.whatItAsksFor`)
                                    }}
                                </p>
                                <ul class="flex flex-col gap-0.5">
                                    <li v-for="power in extension.powers.added" :key="power" class="text-2xs text-content">+ {{ power }}</li>
                                </ul>
                            </template>
                            <ul v-if="extension.powers.removed.length > 0" class="flex flex-col gap-0.5">
                                <li v-for="power in extension.powers.removed" :key="power" class="text-2xs text-subtle">− {{ power }}</li>
                            </ul>
                        </div>
                    </template>
                </Row>
            </RowGroup>

            <!-- Sections render nothing while the read is out, so this outline gives the wait the list's own shape instead of a
                 sentence: the list as it last looked in this sandbox, or until then a group of placeholder rows. -->
            <template v-if="isLoading">
                <SkeletonSnapshot
                    v-if="outline"
                    of="sandbox.extensions.installed"
                    :label="t(`sandbox.extensionsInstalled.readingSandboxsExtensions`)"
                >
                    <RowGroup :label="t(`sandbox.words.installed`)">
                        <div role="status" aria-busy="true">
                            <span class="sr-only">{{ t(`sandbox.extensionsInstalled.readingSandboxsExtensions`) }}</span>
                            <SkeletonRows :rows="3" description control />
                        </div>
                    </RowGroup>
                </SkeletonSnapshot>
            </template>
            <!-- The sections and the empty note as one box (never empty once read: no healthy row means a note), spaced as the
                 column it sits in. -->
            <div v-else v-skeleton-source="`sandbox.extensions.installed`" class="flex flex-col gap-6">
                <RowGroup v-for="section in sections" :key="section.id" :label="section.label" :caption="section.caption">
                    <ExtensionRow
                        v-for="entry in section.entries"
                        :key="entry.extension.id"
                        :data-extension="entry.extension.id"
                        :entry="entry"
                        :pending="extensionBusy(entry.extension.id, extensionIdOf(entry.extension.manifest))"
                        @toggle="(enabled) => toggle(entry.extension, enabled)"
                        @open="openExtension(entry.extension.id)"
                    />
                </RowGroup>

                <div v-if="emptyNote !== undefined" :class="ui.emptyState(`flex flex-col items-center gap-2 py-6`)">
                    <span>{{ emptyNote }}</span>
                    <!-- An empty list is the moment to answer 'where do extensions come from', not just point at another surface. -->
                    <button v-if="entries.length === 0" type="button" :class="ui.textButton()" @click="emit(`browse`)">
                        {{ t(`sandbox.extensionsInstalled.discoverWhatPeoplePublished`) }}
                    </button>
                    <!-- The empty state answers the active filter before offering reset. -->
                    <button v-if="matches.length === 0 && publishedMatches > 0" type="button" :class="ui.textButton()" @click="emit(`browse`)">
                        {{ t(`sandbox.extensionsInstalled.publishedMatches`, { count: publishedMatches, query: query.trim() }, publishedMatches) }}
                    </button>
                    <Button
                        v-if="matches.length === 0 && entries.length > 0"
                        size="small"
                        :label="t(`ui.action.clearFilter`)"
                        @click="emit(`clear`)"
                    />
                </div>
            </div>

            <!-- Unenumerated workspace extensions are listed with their reason. -->
            <RowGroup v-if="invalid.length > 0" :label="t(`sandbox.extensionsInstalled.notLoadable`)">
                <Row v-for="entry in invalid" :key="entry.dir">
                    <template #title>
                        <span class="block truncate">.intentic/config/workspace-extensions/{{ entry.dir }}</span>
                    </template>
                    <template #description>
                        <span class="text-danger">{{ entry.error }}</span>
                    </template>
                    <template #meta><StatusBadge variant="danger" :label="t(`sandbox.extensionsInstalled.invalid`)" size="xs" /></template>
                </Row>
            </RowGroup>

            <!-- Running in this app build, absent from the daemon's list: no row to sit in, no switch to offer. -->
            <RowGroup v-if="unlisted.length > 0" :label="t(`sandbox.extensionsInstalled.runningNotListed`)">
                <Row v-for="status in unlisted" :key="status.id">
                    <template #title>
                        <span class="block truncate">{{ status.extensionId }}</span>
                    </template>
                    <template v-if="status.detail" #description>
                        <span class="text-warning">{{ status.detail }}</span>
                    </template>
                    <template #meta>
                        <StatusBadge :variant="status.state === `error` ? `danger` : `warning`" :label="hostStateWord(status.state)" size="xs" />
                    </template>
                </Row>
            </RowGroup>
        </template>

        <!-- Removal takes state the owner configured themselves, so it is never one click: the dialog reads the plan
             first and names every connection, credential and file that goes with it. -->
        <ExtensionRemoveDialog :extension="removing" :busy="removingNow" @close="removing = undefined" @confirm="void confirmRemove()" />
    </div>
</template>
