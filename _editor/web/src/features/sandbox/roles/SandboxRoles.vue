<script setup lang="ts">
import { type BuiltInRoleId, isBuiltInRole, type Role } from "@intentic/sandbox-contract/schemas/roles";
import {
    Await,
    Button,
    ui,
    ConfirmDialog,
    InlineRename,
    Notice,
    type NoticeModel,
    RoleFace,
    Row,
    RowGroup,
    RowNote,
    Section,
    SkeletonRows,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import RoleSelector from "./RoleSelector.vue";
import RoleForm, { type RoleDraft } from "./RoleForm.vue";
import RolesExplainer from "./RolesExplainer.vue";
import BuiltInRolePanel from "./BuiltInRolePanel.vue";
import { builtInRoleView, builtInRoleViews } from "../../../models/sandbox/roles/builtInRoles";
import { useBrowserAccounts } from "../../extensions/useBrowserAccounts";
import { omittedNotesOf, roleSlug } from "../../../models/sandbox/roles/roleRules";
import { useRoles } from "../../../models/sandbox/roles/useRoles";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// The roles this sandbox wears when it acts outside: which accounts it speaks through, where it opens, what it is told.
// What a conversation wearing one may reach is access (Access ▸ Profiles), shown on its Access tab. Not per-site: one role spans every platform under that name. Lives here, not on /capabilities, since it's a
// property of the box; under "Reach", not "Configuration", since it's who acts, not what pays.

const t = useT();

const props = defineProps<{
    // A role to land on open, named by the link that brought the reader here.
    open?: string;
}>();

const { roles, connected, isConnected, loaded, save, remove } = useRoles();
// The list query reports a bare message; this page names what the user came here to read.
const unread = (detail: string): NoticeModel => ({ tone: `danger`, title: t(`sandbox.sandboxRoles.couldntReadRoles`), detail });
const listNotice = computed(() => (loaded.value.state === `ready` && loaded.value.refreshError !== undefined ? unread(loaded.value.refreshError) : undefined));
// Logged-in browser profiles, each carrying its site's brand; one capability per account, so a twice-connected site
// appears twice.
const { accounts } = useBrowserAccounts();

// Whether a role can act at all right now: one signed-in account among several is enough, so this only marks a role
// that can reach nothing.
const ready = (role: Role): boolean => role.capabilities.some((id) => isConnected(id));

// The two roles every sandbox has, first in the grid as tiles like any other, but locked: no remove, and opening one
// shows what it reaches and when it is worn instead of an editor (schemas/roles.ts says why they are not cards).
const builtIns = builtInRoleViews();
const builtInCard = (id: BuiltInRoleId): Role => ({ id, label: builtInRoleView(id).label, capabilities: [] });
const openBuiltIn = ref<BuiltInRoleId | undefined>(undefined);
const openBuiltInView = computed(() => (openBuiltIn.value === undefined ? undefined : builtInRoleView(openBuiltIn.value)));

// One selected role, edited below the grid. Changes save as they are made; selecting a tile is never an edit.
const draft = ref<RoleDraft | undefined>(undefined);
const saveError = ref<NoticeModel | undefined>(undefined);
const removeError = ref<NoticeModel | undefined>(undefined);
const detailsId = useId();
const selected = computed(() => roles.value.find((role) => role.id === draft.value?.original));

const draftOf = (role: Role): RoleDraft => ({
    original: role.id,
    label: role.label ?? role.id,
    capabilities: [...role.capabilities],
    // One folder or none, carried as a list, matching what the picker models either way.
    startIn: role.workspace?.startIn === undefined ? [] : [role.workspace.startIn],
    systemPromptMode: role.systemPromptMode,
    brief: role.brief ?? ``,
    // Absent context means every repository; a list, even empty, is the role deciding.
    carries: role.context === undefined ? undefined : [...role.context.repos],
    models: [...(role.models ?? [])],
    omitNotes: omittedNotesOf(role),
});

// Marks a draft change as not-an-edit (opening a role, or writing back a committed rename), so the autosave watcher
// doesn't fire a write nobody asked for.
let settling = false;
const quietly = (mutate: () => void): void => {
    settling = true;
    mutate();
    void nextTick(() => {
        settling = false;
    });
};

const newName = ref<string | undefined>(undefined);

const isOpen = (role: Role): boolean => draft.value?.original === role.id;
const toggleOpen = (role: Role): void => {
    saveError.value = undefined;
    newName.value = undefined;
    openBuiltIn.value = undefined;
    if (isOpen(role)) {
        draft.value = undefined;
        return;
    }
    quietly(() => {
        draft.value = draftOf(role);
    });
};

// Opening a built-in closes any card, whose queued edit the draft watcher below still writes.
const toggleBuiltIn = (id: BuiltInRoleId): void => {
    saveError.value = undefined;
    newName.value = undefined;
    draft.value = undefined;
    openBuiltIn.value = openBuiltIn.value === id ? undefined : id;
};

// Opening, closing or renaming one rewrites the address. Replaced, not pushed: picking a tile is not a visit. This watch
// is registered before the arrival one so a role the first render selects is written back too.
const route = useRoute();
const router = useRouter();
watch(
    () => draft.value?.original ?? openBuiltIn.value,
    (id) => {
        if (id !== props.open) {
            void router.replace({ query: { ...route.query, open: id } });
        }
    },
);

// The open role lives in the address (`?open=<id>`, SandboxHub's `open`), so a reload or a shared link lands on it.
// A named role opens once the list holds it, once per naming: a refetch must not reopen one the reader just closed.
// A bare visit opens the first role once the list lands, so the page arrives with its editor in view; one the reader
// closes stays closed, so this arrival is settled once whether it named one, picked the first, or found none.
let landedOn: string | undefined;
let arrived = false;
watch(
    [() => props.open, roles, () => loaded.value.state === `ready`],
    ([asked, , listed], previous) => {
        if (asked !== previous?.[0]) {
            landedOn = undefined;
        }
        if (asked !== undefined) {
            arrived = true;
            if (isBuiltInRole(asked)) {
                if (landedOn !== asked) {
                    landedOn = asked;
                    if (openBuiltIn.value !== asked) {
                        toggleBuiltIn(asked);
                    }
                }
                return;
            }
            const role = roles.value.find((candidate) => candidate.id === asked);
            if (role === undefined || landedOn === asked) {
                return;
            }
            landedOn = asked;
            if (!isOpen(role)) {
                toggleOpen(role);
            }
            return;
        }
        if (arrived || !listed) {
            return;
        }
        arrived = true;
        const first = roles.value[0];
        if (first !== undefined && draft.value === undefined && openBuiltIn.value === undefined && newName.value === undefined) {
            toggleOpen(first);
        }
    },
    { immediate: true },
);

// A name, and nothing else: the role is written with the schema's own defaults (stored as absent, so the file says
// nothing about questions nobody was asked), then opens for the rest. The name lives in its own ref rather than a
// half-built draft, since a draft with no `original` would need every field to be optional-until-saved.
const startAdd = (): void => {
    saveError.value = undefined;
    draft.value = undefined;
    openBuiltIn.value = undefined;
    newName.value = ``;
};
const cancelAdd = (): void => {
    newName.value = undefined;
    saveError.value = undefined;
};

const newId = computed(() => roleSlug(newName.value ?? ``));
// A new role can't land on a name already taken; saving would silently edit the other one. A built-in's id is
// always taken: the daemon refuses a card wearing one.
const reserved = computed(() => isBuiltInRole(newId.value));
const taken = computed(() => reserved.value || roles.value.some((role) => role.id === newId.value));
const newValid = computed(() => newId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (newName.value === undefined || newName.value === `` || newValid.value) {
        return undefined;
    }
    if (reserved.value) {
        return t(`sandbox.builtInRoles.reserved`, { name: newName.value });
    }
    return taken.value ? t(`sandbox.sandboxRoles.roleNameTaken`, { name: newId.value }) : t(`sandbox.sandboxRoles.useLettersOrDigits`);
});

// Stores only what was decided: no `workspace` for a role that opens at the root. Same rule the label follows, shared
// with roleRules.ts since the quick panel writes roles too.
const cardFrom = (state: RoleDraft): Role => {
    const id = state.original;
    return {
        id,
        // Only worth storing when it says something the id does not.
        ...(state.label.trim() !== `` && state.label.trim() !== id ? { label: state.label.trim() } : {}),
        capabilities: [...state.capabilities],
        ...(state.startIn[0] !== undefined ? { workspace: { startIn: state.startIn[0] } } : {}),
        // Same rule: a role following the sandbox stores nothing, not a restated default.
        ...(state.systemPromptMode !== undefined ? { systemPromptMode: state.systemPromptMode } : {}),
        ...runsOn(state),
    };
};

// The fifth question's half of the role, same rule: an unset brief, full-carry, empty ladder, or a role that drops no
// preamble note each store nothing.
const runsOn = (state: RoleDraft): Pick<Role, "brief" | "context" | "models" | "briefing"> => ({
    ...(state.brief.trim() !== `` ? { brief: state.brief.trim() } : {}),
    ...(state.carries !== undefined ? { context: { repos: [...state.carries] } } : {}),
    ...(state.models.length > 0 ? { models: [...state.models] } : {}),
    ...(state.omitNotes.length > 0 ? { briefing: { omit: [...state.omitNotes] } } : {}),
});

// Writes the role with just its name and an empty account list; every other field is a default the schema already
// means. Then opens the new role, since "made a role" and "now set it up" are one errand.
const submitting = ref(false);
const submit = async (): Promise<void> => {
    // `taken` only sees roles already fetched, so without this the id being written right now still reads as free.
    if (!newValid.value || submitting.value) {
        return;
    }
    const id = newId.value;
    const label = (newName.value ?? ``).trim();
    saveError.value = undefined;
    submitting.value = true;
    try {
        await save.mutateAsync({ id, capabilities: [], ...(label !== id ? { label } : {}) });
        newName.value = undefined;
        // Quietly, like any other open, so the autosave watcher doesn't treat the role it just showed as an edit.
        quietly(() => {
            draft.value = draftOf({ id, capabilities: [], ...(label !== id ? { label } : {}) });
        });
    } catch (err) {
        saveError.value = noticeFrom(err, t(`sandbox.sandboxRoles.couldntSaveRole`));
    } finally {
        submitting.value = false;
    }
};

// Debounced, since several flips or a folder pick are one intent, not one write each; long enough to coalesce a
// decision, short enough that the spinner has cleared by the time attention moves on.
let pending: ReturnType<typeof setTimeout> | undefined;
const persist = async (state: RoleDraft): Promise<void> => {
    try {
        await save.mutateAsync(cardFrom(state));
    } catch (err) {
        if (draft.value === state) {
            saveError.value = noticeFrom(err, t(`sandbox.sandboxRoles.couldntSaveRole`));
        }
    }
};
watch(
    draft,
    (state, previous) => {
        // Finish a queued edit against its own role before the selection changes.
        if (state !== previous && pending !== undefined) {
            clearTimeout(pending);
            pending = undefined;
            if (previous !== undefined) {
                void persist(previous);
            }
        }
        if (settling || state === undefined) {
            return;
        }
        clearTimeout(pending);
        saveError.value = undefined;
        pending = setTimeout(() => {
            pending = undefined;
            void persist(state);
        }, 400);
    },
    { deep: true },
);
onBeforeUnmount(() => clearTimeout(pending));

// Renaming includes the open draft so it keeps a switch flipped a moment ago.
const renameOf =
    (role: Role) =>
    async (name: string): Promise<void> => {
        const open = draft.value?.original === role.id ? draft.value : undefined;
        await save.mutateAsync(open !== undefined ? { ...cardFrom(open), label: name } : { ...role, label: name });
        if (open !== undefined) {
            quietly(() => {
                open.label = name;
            });
        }
    };

// Whether a new chat is matched to a role from its first message (settings.roleRouting). Read in the same one
// call that chooses what the chat runs on (daemon's chat-router.ts); this switch decides only whether that call is
// asked the role half. Lives here, not with the model lists, since a decision about it needs the roles it would
// choose between.
const { settings, patch } = useSandboxSettings();
const roleRouting = computed(() => settings.value?.roleRouting ?? true);
const setRoleRouting = (on: boolean): void => {
    patch({ roleRouting: on });
};

// Removal.
const removing = ref<Role | undefined>(undefined);
const confirmRemove = async (): Promise<void> => {
    if (removing.value === undefined) {
        return;
    }
    const id = removing.value.id;
    if (draft.value?.original === id) {
        clearTimeout(pending);
        pending = undefined;
    }
    // A role an automation still wears is refused by the daemon, which names the automations: said here, not lost.
    try {
        await remove.mutateAsync(id);
    } catch (error) {
        removeError.value = noticeFrom(error, t(`sandbox.sandboxRoles.couldntRemoveRole`));
        return;
    }
    if (draft.value?.original === id) {
        draft.value = undefined;
    }
    removing.value = undefined;
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup
            v-if="settings !== undefined && roles.length > 0"
            data-setting="roles-new-chats"
            :label="t(`sandbox.sandboxRoles.newChats`)"
        >
            <Row
                icon="users"
                :title="t(`sandbox.sandboxRoles.matchNewChatsTo`)"
                :description="roleRouting ? t(`sandbox.sandboxRoles.firstMessageReadSend`) : t(`sandbox.sandboxRoles.nothingReadChatActs`)"
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="roleRouting"
                        :aria-label="t(`sandbox.sandboxRoles.matchNewChatsTo`)"
                        @update:model-value="setRoleRouting"
                    />
                </template>
            </Row>
        </RowGroup>

        <Notice v-if="listNotice" :of="listNotice" />
        <!-- The real list must not show before we know whether roles exist; the list's shape stands in while loading. -->
        <!-- Drawn as the list last looked in this sandbox. Until then a <RowGroup> like the list itself, so it lands on the
             same tier as what it stands in for. -->
        <Await :of="loaded" imprint="sandbox.roles" :label="t(`sandbox.sandboxRoles.readingSandboxsRoles`)">
            <template #fallback>
                <RowGroup :label="t(`sandbox.sandboxRoles.roles`)">
                    <div role="status" aria-busy="true">
                        <span class="sr-only">{{ t(`sandbox.sandboxRoles.readingSandboxsRoles`) }}</span>
                        <SkeletonRows :rows="2" description control />
                    </div>
                </RowGroup>
            </template>
            <template #failed="{ error }"><Notice :of="unread(error)" /></template>

            <!-- Never empty: the two built-ins lead the grid, so a sandbox with no cards of its own still shows who its
                 chats and runs act as. Roles may exist without connected accounts. -->
            <Section :label="t(`sandbox.sandboxRoles.roles`)">
                <!-- What a role is, drawn: the tiles show which ones exist, nothing else says what one is. -->
                <template #info><RolesExplainer /></template>
                <template #actions>
                    <!-- Never disabled for having no accounts: a role with none still bounds where an agent works. With
                         no card of its own yet, adding one is the step this list is asking for. -->
                    <Button
                        v-if="newName === undefined"
                        :label="t(`sandbox.sandboxRoles.addRole`)"
                        size="small"
                        :tier="roles.length === 0 ? `accent` : `boring`"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <div role="group" :aria-label="t(`sandbox.sandboxRoles.roles`)" class="flex flex-wrap gap-1">
                    <RoleSelector
                        v-for="builtIn in builtIns"
                        :key="builtIn.id"
                        :role="builtInCard(builtIn.id)"
                        :built-in="builtIn"
                        :selected="openBuiltIn === builtIn.id"
                        :controls="detailsId"
                        :signed-in="true"
                        :saving="false"
                        @select="toggleBuiltIn(builtIn.id)"
                    />
                    <!-- Built-ins first, then the sandbox's own, with a hairline between the two kinds. -->
                    <span v-if="roles.length > 0" class="mx-1 my-3 border-l border-line" aria-hidden="true" />
                    <RoleSelector
                        v-for="role in roles"
                        :key="role.id"
                        :role="role"
                        :selected="isOpen(role)"
                        :controls="detailsId"
                        :signed-in="ready(role)"
                        :saving="isOpen(role) && save.isPending.value"
                        @select="toggleOpen(role)"
                        @remove="removing = role"
                    />
                </div>

                <!-- What having no card of its own means, said where the cards would be. -->
                <p v-if="roles.length === 0 && newName === undefined" class="m-0 mt-3 text-xs text-muted">
                    <span class="font-medium text-content">{{ t(`sandbox.sandboxRoles.noRolesYet`) }}.</span>
                    {{ t(`sandbox.sandboxRoles.untilOneAutomationSchedule`) }}
                </p>

                <div :id="detailsId" class="mt-4">
                    <BuiltInRolePanel v-if="openBuiltInView" :key="openBuiltInView.id" :role="openBuiltInView" />
                    <div v-else-if="selected && draft" :key="selected.id" class="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm">
                        <!-- The role's name, renamed in place beside its pencil: the app's one rename, as the sandbox's. -->
                        <h3 class="-ml-1 flex min-w-0 text-base font-semibold">
                            <InlineRename
                                :value="selected.label ?? selected.id"
                                :write="renameOf(selected)"
                                :label="t(`sandbox.sandboxRoles.roleName`)"
                                :action="t(`sandbox.sandboxRoles.renameRole`)"
                                :failure="t(`sandbox.roleSelector.couldntRename`)"
                            />
                        </h3>
                        <RoleForm
                            :show-repositories="route.query[`repositories`] === `true`"
                            :draft="draft"
                            :accounts="accounts"
                            :connected="connected"
                            :error="saveError"
                        />
                    </div>
                </div>

                <!-- Creation asks only for the role name; other fields have defaults. -->
                <RowNote v-if="newName !== undefined" v-slot="{ mark }" variant="block" lead="face">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <!-- `lead="face"` for the same reason the rows above carry it: the preview must be the face it commits to. -->
                            <RoleFace :role="{ id: newId || `role`, label: newName || undefined }" :size="mark" />
                            <!-- Capped width, since a name is a few words, not a paragraph; Enter commits, like a single-field form. -->
                            <input
                                v-model="newName"
                                :class="ui.input('min-w-0 max-w-xs flex-1 font-medium')"
                                :placeholder="t(`sandbox.sandboxRoles.nameWorkStudioReddit`)"
                                :aria-label="t(`sandbox.sandboxRoles.nameRole`)"
                                autofocus
                                @keyup.enter="submit"
                            />
                            <Button
                                tier="accent"
                                :label="t(`ui.action.create`)"
                                size="small"
                                :loading="save.isPending.value"
                                :disabled="!newValid"
                                @click="submit"
                            />
                            <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="cancelAdd">
                                {{ t(`ui.action.cancel`) }}
                            </button>
                        </div>
                        <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
                        <span v-else class="text-xs text-subtle">
                            {{ t(`sandbox.sandboxRoles.startsFullToolboxWhole`) }}
                        </span>
                        <Notice v-if="saveError !== undefined" :of="saveError" />
                    </div>
                </RowNote>
            </Section>
        </Await>

        <!-- Removing a role, never an account, worth saying since only one of those is undoable by clicking again. -->
        <ConfirmDialog
            :open="removing !== undefined"
            :header="t(`sandbox.sandboxRoles.remove`, { id: removing?.label ?? removing?.id })"
            :description="t(`sandbox.sandboxRoles.accountsSpeaksThroughStay`)"
            :confirm-label="t(`sandbox.sandboxRoles.removeRole2`)"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="
                removing = undefined;
                removeError = undefined;
            "
            @confirm="confirmRemove"
        >
            <Notice v-if="removeError !== undefined" :of="removeError" />
        </ConfirmDialog>
    </div>
</template>
