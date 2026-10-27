<script setup lang="ts">
import { type BuiltInPersonaId, isBuiltInPersona, type Persona } from "@intentic/sandbox-contract/schemas/personas";
import {
    Await,
    Button,
    ui,
    ConfirmDialog,
    InlineRename,
    Notice,
    type NoticeModel,
    PersonaFace,
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
import PersonaSelector from "./PersonaSelector.vue";
import PersonaForm, { type PersonaDraft } from "./PersonaForm.vue";
import PersonasExplainer from "./PersonasExplainer.vue";
import BuiltInPersonaPanel from "./BuiltInPersonaPanel.vue";
import { builtInPersonaView, builtInPersonaViews } from "../../../models/sandbox/personas/builtInPersonas";
import { useBrowserAccounts } from "../../extensions/useBrowserAccounts";
import { useCapabilities } from "../../../models/capabilities/useCapabilities";
import { useExtensions } from "../../../models/extensions/useExtensions";
import {
    extensionGrantablesFrom,
    grantablesFrom,
    omittedNotesOf,
    type PersonaGrantable,
    personaSlug,
    powersDraftOf,
    storedPowers,
} from "../../../models/sandbox/personas/personaRules";
import { usePersonas } from "../../../models/sandbox/personas/usePersonas";
import { useSandboxSettings } from "../../../models/sandbox/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// The personas this sandbox wears when it acts outside: which accounts it speaks through, what it may do, where it
// works. Not per-site: one persona spans every platform under that name. Lives here, not on /capabilities, since it's a
// property of the box; under "Reach", not "Configuration", since it's who acts, not what pays.

const t = useT();

const props = defineProps<{
    // A persona to land on open, named by the link that brought the reader here.
    open?: string;
}>();

const { personas, connected, isConnected, loaded, save, remove } = usePersonas();
// The list query reports a bare message; this page names what the user came here to read.
const unread = (detail: string): NoticeModel => ({ tone: `danger`, title: t(`sandbox.sandboxPersonas.couldntReadPersonas`), detail });
const listNotice = computed(() => (loaded.value.state === `ready` && loaded.value.refreshError !== undefined ? unread(loaded.value.refreshError) : undefined));
// Logged-in browser profiles, each carrying its site's brand; one capability per account, so a twice-connected site
// appears twice.
const { accounts } = useBrowserAccounts();

// The other four things a persona grants by id (see grantablesFrom, extensionGrantablesFrom), shared with the Workspace
// tree's quick panel.
const { capabilities } = useCapabilities();
const { extensions } = useExtensions();
const grantables = computed<PersonaGrantable[]>(() => [...grantablesFrom(capabilities.value), ...extensionGrantablesFrom(extensions.value)]);

// Whether a persona can act at all right now: one signed-in account among several is enough, so this only marks a persona
// that can reach nothing.
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

// The two personas every sandbox has, first in the grid as tiles like any other, but locked: no remove, and opening one
// shows what it reaches and when it is worn instead of an editor (schemas/personas.ts says why they are not cards).
const builtIns = builtInPersonaViews();
const builtInCard = (id: BuiltInPersonaId): Persona => ({ id, label: builtInPersonaView(id).label, capabilities: [] });
const openBuiltIn = ref<BuiltInPersonaId | undefined>(undefined);
const openBuiltInView = computed(() => (openBuiltIn.value === undefined ? undefined : builtInPersonaView(openBuiltIn.value)));

// One selected persona, edited below the grid. Changes save as they are made; selecting a tile is never an edit.
const draft = ref<PersonaDraft | undefined>(undefined);
const saveError = ref<NoticeModel | undefined>(undefined);
const removeError = ref<NoticeModel | undefined>(undefined);
const detailsId = useId();
const selected = computed(() => personas.value.find((persona) => persona.id === draft.value?.original));

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
    // Absent context means every repository; a list, even empty, is the persona deciding.
    carries: persona.context === undefined ? undefined : [...persona.context.repos],
    models: [...(persona.models ?? [])],
    omitNotes: omittedNotesOf(persona),
});

// Marks a draft change as not-an-edit (opening a persona, or writing back a committed rename), so the autosave watcher
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

const isOpen = (persona: Persona): boolean => draft.value?.original === persona.id;
const toggleOpen = (persona: Persona): void => {
    saveError.value = undefined;
    newName.value = undefined;
    openBuiltIn.value = undefined;
    if (isOpen(persona)) {
        draft.value = undefined;
        return;
    }
    quietly(() => {
        draft.value = draftOf(persona);
    });
};

// Opening a built-in closes any card, whose queued edit the draft watcher below still writes.
const toggleBuiltIn = (id: BuiltInPersonaId): void => {
    saveError.value = undefined;
    newName.value = undefined;
    draft.value = undefined;
    openBuiltIn.value = openBuiltIn.value === id ? undefined : id;
};

// Opening, closing or renaming one rewrites the address. Replaced, not pushed: picking a tile is not a visit. This watch
// is registered before the arrival one so a persona the first render selects is written back too.
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

// The open persona lives in the address (`?open=<id>`, SandboxHub's `open`), so a reload or a shared link lands on it.
// A named persona opens once the list holds it, once per naming: a refetch must not reopen one the reader just closed.
// A bare visit opens the first persona once the list lands, so the page arrives with its editor in view; one the reader
// closes stays closed, so this arrival is settled once whether it named one, picked the first, or found none.
let landedOn: string | undefined;
let arrived = false;
watch(
    [() => props.open, personas, () => loaded.value.state === `ready`],
    ([asked, , listed], previous) => {
        if (asked !== previous?.[0]) {
            landedOn = undefined;
        }
        if (asked !== undefined) {
            arrived = true;
            if (isBuiltInPersona(asked)) {
                if (landedOn !== asked) {
                    landedOn = asked;
                    if (openBuiltIn.value !== asked) {
                        toggleBuiltIn(asked);
                    }
                }
                return;
            }
            const persona = personas.value.find((candidate) => candidate.id === asked);
            if (persona === undefined || landedOn === asked) {
                return;
            }
            landedOn = asked;
            if (!isOpen(persona)) {
                toggleOpen(persona);
            }
            return;
        }
        if (arrived || !listed) {
            return;
        }
        arrived = true;
        const first = personas.value[0];
        if (first !== undefined && draft.value === undefined && openBuiltIn.value === undefined && newName.value === undefined) {
            toggleOpen(first);
        }
    },
    { immediate: true },
);

// A name, and nothing else: the persona is written with the schema's own defaults (stored as absent, so the file says
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

const newId = computed(() => personaSlug(newName.value ?? ``));
// A new persona can't land on a name already taken; saving would silently edit the other one. A built-in's id is
// always taken: the daemon refuses a card wearing one.
const reserved = computed(() => isBuiltInPersona(newId.value));
const taken = computed(() => reserved.value || personas.value.some((persona) => persona.id === newId.value));
const newValid = computed(() => newId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (newName.value === undefined || newName.value === `` || newValid.value) {
        return undefined;
    }
    if (reserved.value) {
        return t(`sandbox.builtInPersonas.reserved`, { name: newName.value });
    }
    return taken.value ? t(`sandbox.sandboxPersonas.personaNameTaken`, { name: newId.value }) : t(`sandbox.sandboxPersonas.useLettersOrDigits`);
});

// Stores only what was decided: no `powers` for a persona that grants everything, no `workspace` for one that limits
// nothing. Same rule the label follows, shared with personaRules.ts since the quick panel writes personas too.
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
        // Same rule: a persona following the sandbox stores nothing, not a restated default.
        ...(state.systemPromptMode !== undefined ? { systemPromptMode: state.systemPromptMode } : {}),
        ...runsOn(state),
    };
};

// The fifth question's half of the persona, same rule: an unset brief, full-carry, empty ladder, or a persona that drops no
// preamble note each store nothing.
const runsOn = (state: PersonaDraft): Pick<Persona, "brief" | "context" | "models" | "briefing"> => ({
    ...(state.brief.trim() !== `` ? { brief: state.brief.trim() } : {}),
    ...(state.carries !== undefined ? { context: { repos: [...state.carries] } } : {}),
    ...(state.models.length > 0 ? { models: [...state.models] } : {}),
    ...(state.omitNotes.length > 0 ? { briefing: { omit: [...state.omitNotes] } } : {}),
});

// Writes the persona with just its name and an empty account list; every other field is a default the schema already
// means. Then opens the new persona, since "made a persona" and "now set it up" are one errand.
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
        // Quietly, like any other open, so the autosave watcher doesn't treat the persona it just showed as an edit.
        quietly(() => {
            draft.value = draftOf({ id, capabilities: [], ...(label !== id ? { label } : {}) });
        });
    } catch (err) {
        saveError.value = noticeFrom(err, t(`sandbox.sandboxPersonas.couldntSavePersona`));
    } finally {
        submitting.value = false;
    }
};

// Debounced, since several flips or a folder pick are one intent, not one write each; long enough to coalesce a
// decision, short enough that the spinner has cleared by the time attention moves on.
let pending: ReturnType<typeof setTimeout> | undefined;
const persist = async (state: PersonaDraft): Promise<void> => {
    try {
        await save.mutateAsync(cardFrom(state));
    } catch (err) {
        if (draft.value === state) {
            saveError.value = noticeFrom(err, t(`sandbox.sandboxPersonas.couldntSavePersona`));
        }
    }
};
watch(
    draft,
    (state, previous) => {
        // Finish a queued edit against its own persona before the selection changes.
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

// Whether a new chat is matched to a persona from its first message (settings.personaRouting). Read in the same one
// call that chooses what the chat runs on (daemon's chat-router.ts); this switch decides only whether that call is
// asked the persona half. Lives here, not with the model lists, since a decision about it needs the personas it would
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
    const id = removing.value.id;
    if (draft.value?.original === id) {
        clearTimeout(pending);
        pending = undefined;
    }
    // A persona an automation still wears is refused by the daemon, which names the automations: said here, not lost.
    try {
        await remove.mutateAsync(id);
    } catch (error) {
        removeError.value = noticeFrom(error, t(`sandbox.sandboxPersonas.couldntRemovePersona`));
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
            v-if="settings !== undefined && personas.length > 0"
            data-setting="personas-new-chats"
            :label="t(`sandbox.sandboxPersonas.newChats`)"
        >
            <Row
                icon="users"
                :title="t(`sandbox.sandboxPersonas.matchNewChatsTo`)"
                :description="personaRouting ? t(`sandbox.sandboxPersonas.firstMessageReadSend`) : t(`sandbox.sandboxPersonas.nothingReadChatActs`)"
            >
                <template #control>
                    <ToggleSwitch
                        :model-value="personaRouting"
                        :aria-label="t(`sandbox.sandboxPersonas.matchNewChatsTo`)"
                        @update:model-value="setPersonaRouting"
                    />
                </template>
            </Row>
        </RowGroup>

        <Notice v-if="listNotice" :of="listNotice" />
        <!-- The real list must not show before we know whether personas exist; the list's shape stands in while loading. -->
        <!-- Drawn as the list last looked in this sandbox. Until then a <RowGroup> like the list itself, so it lands on the
             same tier as what it stands in for. -->
        <Await :of="loaded" imprint="sandbox.personas" :label="t(`sandbox.sandboxPersonas.readingSandboxsPersonas`)">
            <template #fallback>
                <RowGroup :label="t(`sandbox.sandboxPersonas.personas`)">
                    <div role="status" aria-busy="true">
                        <span class="sr-only">{{ t(`sandbox.sandboxPersonas.readingSandboxsPersonas`) }}</span>
                        <SkeletonRows :rows="2" description control />
                    </div>
                </RowGroup>
            </template>
            <template #failed="{ error }"><Notice :of="unread(error)" /></template>

            <!-- Never empty: the two built-ins lead the grid, so a sandbox with no cards of its own still shows who its
                 chats and runs act as. Personas may exist without connected accounts. -->
            <Section :label="t(`sandbox.sandboxPersonas.personas`)">
                <!-- What a persona is, drawn: the tiles show which ones exist, nothing else says what one is. -->
                <template #info><PersonasExplainer /></template>
                <template #actions>
                    <!-- Never disabled for having no accounts: a persona with none still bounds where an agent works. With
                         no card of its own yet, adding one is the step this list is asking for. -->
                    <Button
                        v-if="newName === undefined"
                        :label="t(`sandbox.sandboxPersonas.addPersona`)"
                        size="small"
                        :tier="personas.length === 0 ? `accent` : `boring`"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <div role="group" :aria-label="t(`sandbox.sandboxPersonas.personas`)" class="flex flex-wrap gap-1">
                    <PersonaSelector
                        v-for="builtIn in builtIns"
                        :key="builtIn.id"
                        :persona="builtInCard(builtIn.id)"
                        :built-in="builtIn"
                        :selected="openBuiltIn === builtIn.id"
                        :controls="detailsId"
                        :signed-in="true"
                        :saving="false"
                        @select="toggleBuiltIn(builtIn.id)"
                    />
                    <!-- Built-ins first, then the sandbox's own, with a hairline between the two kinds. -->
                    <span v-if="personas.length > 0" class="mx-1 my-3 border-l border-line" aria-hidden="true" />
                    <PersonaSelector
                        v-for="persona in personas"
                        :key="persona.id"
                        :persona="persona"
                        :selected="isOpen(persona)"
                        :controls="detailsId"
                        :signed-in="ready(persona)"
                        :saving="isOpen(persona) && save.isPending.value"
                        @select="toggleOpen(persona)"
                        @remove="removing = persona"
                    />
                </div>

                <!-- What having no card of its own means, said where the cards would be. -->
                <p v-if="personas.length === 0 && newName === undefined" class="m-0 mt-3 text-xs text-muted">
                    <span class="font-medium text-content">{{ t(`sandbox.sandboxPersonas.noPersonasYet`) }}.</span>
                    {{ t(`sandbox.sandboxPersonas.untilOneAutomationSchedule`) }}
                </p>

                <div :id="detailsId" class="mt-4">
                    <BuiltInPersonaPanel v-if="openBuiltInView" :key="openBuiltInView.id" :persona="openBuiltInView" />
                    <div v-else-if="selected && draft" :key="selected.id" class="flex flex-col gap-3 rounded-xl bg-card p-4 shadow-sm">
                        <!-- The persona's name, renamed in place beside its pencil: the app's one rename, as the sandbox's. -->
                        <h3 class="-ml-1 flex min-w-0 text-base font-semibold">
                            <InlineRename
                                :value="selected.label ?? selected.id"
                                :write="renameOf(selected)"
                                :label="t(`sandbox.sandboxPersonas.personaName`)"
                                :action="t(`sandbox.sandboxPersonas.renamePersona`)"
                                :failure="t(`sandbox.personaSelector.couldntRename`)"
                            />
                        </h3>
                        <PersonaForm
                            :show-repositories="route.query[`repositories`] === `true`"
                            :draft="draft"
                            :accounts="accounts"
                            :connected="connected"
                            :grantables="grantables"
                            :error="saveError"
                        />
                    </div>
                </div>

                <!-- Creation asks only for the persona name; other fields have defaults. -->
                <RowNote v-if="newName !== undefined" v-slot="{ mark }" variant="block" lead="face">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <!-- `lead="face"` for the same reason the rows above carry it: the preview must be the face it commits to. -->
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
                            {{ t(`sandbox.sandboxPersonas.startsFullToolboxWhole`) }}
                        </span>
                        <Notice v-if="saveError !== undefined" :of="saveError" />
                    </div>
                </RowNote>
            </Section>
        </Await>

        <!-- Removing a persona, never an account, worth saying since only one of those is undoable by clicking again. -->
        <ConfirmDialog
            :open="removing !== undefined"
            :header="t(`sandbox.sandboxPersonas.remove`, { id: removing?.label ?? removing?.id })"
            :description="t(`sandbox.sandboxPersonas.accountsSpeaksThroughStay`)"
            :confirm-label="t(`sandbox.sandboxPersonas.removePersona2`)"
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
