<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import {
    Avatar,
    BrandMark,
    Button,
    ui,
    ConfirmDialog,
    DisclosureRow,
    InlineRename,
    Notice,
    type NoticeModel,
    PersonaFace,
    Row,
    RowGroup,
    RowNote,
    SkeletonRows,
    StatusBadge,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import PersonaForm, { type PersonaDraft } from "./PersonaForm.vue";
import { useBrowserAccounts } from "../../extensions/useBrowserAccounts";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { grantablesFrom, omittedNotesOf, type PersonaGrantable, personaSlug, powersDraftOf, storedPowers } from "./personaCard";
import { usePersonas } from "./usePersonas";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSandboxSettings } from "../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// The personas this sandbox wears when it acts outside: which accounts it speaks through, what it may do, where it
// works. Not per-site: one card spans every platform under that name. Lives here, not on /capabilities, since it's a
// property of the box; under "Reach", not "Configuration", since it's who acts, not what pays.

const t = useT();

const { personas, connected, isConnected, error, isLoading, save, remove } = usePersonas();
const outline = useSandboxOutline(isLoading);
// The list query reports a bare message; this page names what the user came here to read.
const listNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.sandboxPersonas.couldntReadPersonas`), detail: error.value },
);
// Logged-in browser profiles, each carrying its site's brand; one capability per account, so a twice-connected site
// appears twice.
const { accounts, accountOf } = useBrowserAccounts();

// The other three things a card grants by id (see grantablesFrom), shared with the Workspace tree's quick panel.
const { capabilities } = useCapabilities();
const grantables = computed<PersonaGrantable[]>(() => grantablesFrom(capabilities.value));

// Marks for the accounts a card names; an id with no matching capability still gets one, so the row doesn't understate
// what the persona reaches.
const marks = (persona: Persona) => persona.capabilities.map((id) => ({ id, account: accountOf(id), signedIn: isConnected(id) }));

// Whether a card can act at all right now: one signed-in account among several is enough, so this only marks a persona
// that can reach nothing.
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

// Accordion over a settings object: an open card writes as you change it (no Save button), and the row itself is the
// disclosure, there's no separate edit affordance. The name stays the row's own title, text until clicked
// (inlineRename).
const draft = ref<PersonaDraft | undefined>(undefined);
const saveError = ref<NoticeModel | undefined>(undefined);

const draftOf = (persona: Persona): PersonaDraft => ({
    original: persona.id,
    label: persona.label ?? persona.id,
    capabilities: [...persona.capabilities],
    ...powersDraftOf(persona),
    // One folder or none, carried as a list, matching what the picker models either way.
    startIn: persona.workspace?.startIn === undefined ? [] : [persona.workspace.startIn],
    folders: [...(persona.workspace?.folders ?? [])],
    systemPromptMode: persona.systemPromptMode,
    brief: persona.brief ?? ``,
    // Absent context means every repository; a list, even empty, is the card deciding.
    carries: persona.context === undefined ? undefined : [...persona.context.repos],
    models: [...(persona.models ?? [])],
    omitNotes: omittedNotesOf(persona),
});

// Marks a draft change as not-an-edit (opening a card, or writing back a committed rename), so the autosave watcher
// doesn't fire a write nobody asked for.
let settling = false;
const quietly = (mutate: () => void): void => {
    settling = true;
    mutate();
    void nextTick(() => {
        settling = false;
    });
};

const isOpen = (persona: Persona): boolean => draft.value?.original === persona.id;
const toggleOpen = (persona: Persona): void => {
    saveError.value = undefined;
    if (isOpen(persona)) {
        draft.value = undefined;
        return;
    }
    quietly(() => {
        draft.value = draftOf(persona);
    });
};

// A name, and nothing else: the card is written with the schema's own defaults (stored as absent, so the file says
// nothing about questions nobody was asked), then opens for the rest. The name lives in its own ref rather than a
// half-built draft, since a draft with no `original` would need every field to be optional-until-saved.
const newName = ref<string | undefined>(undefined);

const startAdd = (): void => {
    saveError.value = undefined;
    draft.value = undefined;
    newName.value = ``;
};
const cancelAdd = (): void => {
    newName.value = undefined;
    saveError.value = undefined;
};

const newId = computed(() => personaSlug(newName.value ?? ``));
// A new card can't land on a name already taken; saving would silently edit the other one.
const taken = computed(() => personas.value.some((persona) => persona.id === newId.value));
const newValid = computed(() => newId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (newName.value === undefined || newName.value === `` || newValid.value) {
        return undefined;
    }
    return taken.value ? `You already have a persona called ${newId.value}.` : `Use letters or digits.`;
});

// Stores only what was decided: no `powers` for a card that grants everything, no `workspace` for one that limits
// nothing. Same rule the label follows, shared with personaCard.ts since the quick panel writes cards too.
const cardFrom = (state: PersonaDraft): Persona => {
    const id = state.original;
    const workspace = {
        ...(state.startIn[0] !== undefined ? { startIn: state.startIn[0] } : {}),
        ...(state.folders.length > 0 ? { folders: [...state.folders] } : {}),
    };
    return {
        id,
        // Only worth storing when it says something the id does not.
        ...(state.label.trim() !== `` && state.label.trim() !== id ? { label: state.label.trim() } : {}),
        capabilities: [...state.capabilities],
        ...(storedPowers(state) !== undefined ? { powers: storedPowers(state) } : {}),
        ...(Object.keys(workspace).length > 0 ? { workspace } : {}),
        // Same rule: a card following the sandbox stores nothing, not a restated default.
        ...(state.systemPromptMode !== undefined ? { systemPromptMode: state.systemPromptMode } : {}),
        ...runsOn(state),
    };
};

// The fifth question's half of the card, same rule: an unset brief, full-carry, empty ladder, or a card that drops no
// preamble note each store nothing.
const runsOn = (state: PersonaDraft): Pick<Persona, "brief" | "context" | "models" | "briefing"> => ({
    ...(state.brief.trim() !== `` ? { brief: state.brief.trim() } : {}),
    ...(state.carries !== undefined ? { context: { repos: [...state.carries] } } : {}),
    ...(state.models.length > 0 ? { models: [...state.models] } : {}),
    ...(state.omitNotes.length > 0 ? { briefing: { omit: [...state.omitNotes] } } : {}),
});

// Writes the card with just its name and an empty account list; every other field is a default the schema already
// means. Then opens the new card, since "made a persona" and "now set it up" are one errand.
const submitting = ref(false);
const submit = async (): Promise<void> => {
    // `taken` only sees personas already fetched, so without this the id being written right now still reads as free.
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
        // Quietly, like any other open, so the autosave watcher doesn't treat the card it just showed as an edit.
        quietly(() => {
            draft.value = draftOf({ id, capabilities: [], ...(label !== id ? { label } : {}) });
        });
    } catch (err) {
        saveError.value = noticeFrom(err, `Could not save this persona.`);
    } finally {
        submitting.value = false;
    }
};

// Debounced, since several flips or a folder pick are one intent, not one write each; long enough to coalesce a
// decision, short enough that the spinner has cleared by the time attention moves on.
let pending: ReturnType<typeof setTimeout> | undefined;
const persist = async (): Promise<void> => {
    const state = draft.value;
    if (state === undefined) {
        return;
    }
    saveError.value = undefined;
    try {
        await save.mutateAsync(cardFrom(state));
    } catch (err) {
        saveError.value = noticeFrom(err, `Could not save this persona.`);
    }
};
watch(
    draft,
    () => {
        if (settling || draft.value === undefined) {
            return;
        }
        clearTimeout(pending);
        pending = setTimeout(() => void persist(), 400);
    },
    { deep: true },
);
onBeforeUnmount(() => clearTimeout(pending));

// Writes the whole card (an upsert), reading from the open draft if there is one so a rename doesn't clobber a switch
// flipped a moment ago. The edit state is the row's own, inside its <InlineRename>; this is only where the name goes.
const renameOf =
    (persona: Persona) =>
    async (name: string): Promise<void> => {
        const open = draft.value?.original === persona.id ? draft.value : undefined;
        await save.mutateAsync(open !== undefined ? { ...cardFrom(open), label: name } : { ...persona, label: name });
        if (open !== undefined) {
            quietly(() => {
                open.label = name;
            });
        }
    };

// Whether a new chat is matched to a persona from its first message (settings.personaRouting; daemon's
// persona-router.ts reads it). Lives here, not with the model lists, since a decision about it needs the cards it would
// choose between.
const { settings, patch } = useSandboxSettings();
const personaRouting = computed(() => settings.value?.personaRouting ?? true);
const setPersonaRouting = (on: boolean): void => {
    patch({ personaRouting: on });
};

// Removal.
const removing = ref<Persona | undefined>(undefined);
const confirmRemove = async (): Promise<void> => {
    if (removing.value === undefined) {
        return;
    }
    await remove.mutateAsync(removing.value.id);
    removing.value = undefined;
};
</script>

<template>
    <div>
        <RowGroup v-if="settings !== undefined && personas.length > 0" :label="t(`sandbox.sandboxPersonas.newChats`)" class="mb-5">
            <Row
                icon="users"
                :title="t(`sandbox.sandboxPersonas.matchNewChatsTo`)"
                :description="personaRouting ? t(`sandbox.sandboxPersonas.firstMessageReadSend`) : t(`sandbox.sandboxPersonas.nothingReadChatActs`)"
            >
                <template #control>
                    <ToggleSwitch :model-value="personaRouting" @update:model-value="setPersonaRouting" />
                </template>
            </Row>
        </RowGroup>

        <Notice v-if="listNotice" :of="listNotice" class="mb-4" />
        <!-- The real empty state must not show before we know whether personas exist; the list's shape stands in while loading. -->
        <!-- The outline is a <RowGroup> like the list itself, so it lands on the same tier as what it stands in for. -->
        <template v-if="isLoading">
            <RowGroup v-if="outline" :label="t(`sandbox.sandboxPersonas.personas`)">
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.sandboxPersonas.readingSandboxsPersonas`) }}</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>
        </template>

        <template v-else>
            <!-- Personas may exist without connected accounts. -->

            <!-- The empty state names the effects of having no personas. -->
            <div v-if="personas.length === 0 && newName === undefined" :class="ui.emptyState('flex flex-col items-center gap-3 py-8')">
                <Avatar :size="40" />
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium text-content">{{ t(`sandbox.sandboxPersonas.noPersonasYet`) }}</span>
                    <span class="max-w-md text-xs text-muted">
                        {{ t(`sandbox.sandboxPersonas.untilOneAutomationSchedule`) }}
                    </span>
                </div>
                <!-- Never disabled for having no accounts: a card with none still bounds where an agent works. -->
                <Button :label="t(`sandbox.sandboxPersonas.addPersona`)" size="small" @click="startAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <RowGroup v-else :label="t(`sandbox.sandboxPersonas.personas`)">
                <template #actions>
                    <Button
                        v-if="personas.length > 0 && newName === undefined"
                        :label="t(`sandbox.sandboxPersonas.addPersona`)"
                        size="small"
                        severity="secondary"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <!-- The row is the disclosure, no second affordance. -->
                <DisclosureRow
                    v-for="persona in personas"
                    :key="persona.id"
                    hit="pair"
                    body="drawer"
                    :open="isOpen(persona)"
                    @update:open="toggleOpen(persona)"
                >
                    <!-- Persona faces use the row tier's standard mark size. -->
                    <template #lead="{ mark }">
                        <PersonaFace :persona :size="mark" />
                    </template>

                    <!-- The row's name renames itself: same box, same type, and the row never opens on that press. -->
                    <!-- Brief sits in the title column, not `#description`, so it shares the rename's inset and stays under the name. -->
                    <template #title>
                        <div class="flex min-w-0 flex-col">
                            <InlineRename
                                :value="persona.label ?? persona.id"
                                :write="renameOf(persona)"
                                :label="t(`sandbox.sandboxPersonas.personaName`)"
                                :action="t(`sandbox.sandboxPersonas.renamePersona`)"
                                failure="Couldn't rename this persona."
                                class="font-medium"
                            />
                            <span v-if="persona.brief !== undefined" class="truncate px-1 text-2xs text-muted">{{ persona.brief }}</span>
                        </div>
                    </template>

                    <template #meta>
                        <!-- Marks say "spans platforms" faster than words could. -->
                        <span v-if="persona.capabilities.length > 0" class="flex items-center gap-1">
                            <BrandMark
                                v-for="mark in marks(persona)"
                                :key="mark.id"
                                :size="16"
                                :name="mark.account?.site ?? mark.id"
                                :logo="mark.account?.logo"
                                :icon="mark.account?.icon ?? `globe`"
                                :idle="!mark.signedIn"
                            />
                        </span>
                        <!-- A bounded card says so on its row; which shelf is off is the form's business, this is just whether any are. -->
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                        <StatusBadge v-if="persona.capabilities.length > 0 && !ready(persona)" variant="neutral" size="xs" dot>
                            {{ t(`sandbox.sandboxPersonas.notSignedIn`) }}
                        </StatusBadge>
                    </template>

                    <template #control>
                        <!-- Shown only while the write is in flight, since a lingering tick is one more thing to read on every row. -->
                        <Icon v-if="isOpen(persona) && save.isPending.value" name="spinner" spin class="text-2xs text-subtle" />
                        <button
                            type="button"
                            :class="ui.iconButton('hover:text-danger')"
                            :aria-label="t(`sandbox.sandboxPersonas.removePersona`)"
                            @click.stop="removing = persona"
                        >
                            <Icon name="trash" class="text-xs" />
                        </button>
                    </template>

                    <!-- Editing stays inside the persona row. -->
                    <template #below>
                        <PersonaForm :draft="draft!" :accounts="accounts" :connected="connected" :grantables="grantables" :error="saveError" />
                    </template>
                </DisclosureRow>

                <!-- Creation asks only for the persona name; other fields have defaults. -->
                <RowNote v-if="newName !== undefined" v-slot="{ mark }" variant="block">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <!-- The face this row will have once committed, drawn at the same tier size (`mark`) already. -->
                            <PersonaFace :persona="{ id: newId || `persona`, label: newName || undefined }" :size="mark" />
                            <!-- Capped width, since a name is a few words, not a paragraph; Enter commits, like a single-field form. -->
                            <input
                                v-model="newName"
                                :class="ui.input('min-w-0 max-w-xs flex-1 font-medium')"
                                :placeholder="t(`sandbox.sandboxPersonas.nameWorkStudioReddit`)"
                                :aria-label="t(`sandbox.sandboxPersonas.namePersona`)"
                                autofocus
                                @keyup.enter="submit"
                            />
                            <Button
                                :label="t(`ui.action.create`)"
                                size="small"
                                :loading="save.isPending.value"
                                :disabled="!newValid"
                                @click="submit"
                            />
                            <button type="button" :class="ui.linkButton('text-xs text-muted hover:text-content')" @click="cancelAdd">
                                {{ t(`ui.action.cancel`) }}
                            </button>
                        </div>
                        <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
                        <span v-else class="text-xs text-subtle">
                            {{ t(`sandbox.sandboxPersonas.startsFullToolboxWhole`) }}
                        </span>
                        <Notice v-if="saveError !== undefined" :of="saveError" />
                    </div>
                </RowNote>
            </RowGroup>
        </template>

        <!-- Removing a persona, never an account, worth saying since only one of those is undoable by clicking again. -->
        <ConfirmDialog
            :open="removing !== undefined"
            :header="t(`sandbox.sandboxPersonas.remove`, { id: removing?.label ?? removing?.id })"
            :confirm-label="t(`sandbox.sandboxPersonas.removePersona2`)"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="removing = undefined"
            @confirm="confirmRemove"
        >
            {{ t(`sandbox.sandboxPersonas.accountsSpeaksThroughStay`) }}
        </ConfirmDialog>
    </div>
</template>
