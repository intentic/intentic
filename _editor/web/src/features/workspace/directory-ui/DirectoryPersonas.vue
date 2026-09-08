<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { Button, ui, Modal, Notice, type NoticeModel, PersonaFace, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import {
    FULL_POWERS,
    grantablesFrom,
    type PersonaPowersDraft,
    personaSlug,
    personasStartingIn,
    powersDraftOf,
    storedPowers,
} from "../../sandbox/personas/personaCard";
import { usePersonas } from "../../sandbox/personas/usePersonas";
import PersonaPowersFields from "../../sandbox/personas/PersonaPowersFields.vue";

// Who works in this folder, opened from a directory row: one question with three answers — write a new persona
// starting here, point an existing one at this folder (which MOVES it, since a persona has one starting folder),
// or edit one that already starts here. Every save is a whole-card upsert; a field this panel doesn't ask about must be
// carried over, not dropped.

const dir = defineModel<string | undefined>({ required: true });

const { personas, save } = usePersonas();
const { capabilities } = useCapabilities();
const grantables = computed(() => grantablesFrom(capabilities.value));

// Open exactly when there's a folder to be open about — one flag, so there's no open-with-no-folder state.
const visible = computed({
    get: () => dir.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            dir.value = undefined;
        }
    },
});
const folderName = computed(() => dir.value?.split(`/`).pop() ?? ``);
const cards = computed<Persona[]>(() => (dir.value === undefined ? [] : personasStartingIn(personas.value, dir.value)));

// Mode drives everything on screen (heading, fields, button verb) from one piece of state.
// `editing` and `chosen` are cleared entering any other mode, so a picked card can't leak into a name submission.
type Mode = `new` | `existing` | `edit`;
const mode = ref<Mode>(`new`);
// Id of the card being changed (edit) or pointed at this folder (existing).
const editing = ref<string | undefined>(undefined);
const chosen = ref<string | undefined>(undefined);
const filter = ref(``);
const label = ref(``);
const powers = ref<PersonaPowersDraft>({ ...FULL_POWERS });
const advanced = ref(false);
const saveError = ref<NoticeModel | undefined>(undefined);

const startAdd = (): void => {
    mode.value = `new`;
    editing.value = undefined;
    chosen.value = undefined;
    filter.value = ``;
    label.value = ``;
    powers.value = { ...FULL_POWERS };
    advanced.value = false;
    saveError.value = undefined;
};
const startEdit = (persona: Persona): void => {
    mode.value = `edit`;
    editing.value = persona.id;
    chosen.value = undefined;
    label.value = persona.label ?? persona.id;
    powers.value = powersDraftOf(persona);
    // Auto-expanded when editing, since changing bounds is the usual reason to open an existing card.
    advanced.value = persona.powers !== undefined;
    saveError.value = undefined;
};
const startExisting = (): void => {
    mode.value = `existing`;
    editing.value = undefined;
    chosen.value = undefined;
    filter.value = ``;
    saveError.value = undefined;
};

// A second folder must not inherit the first one's half-typed name or a previous save failure.
watch(dir, () => startAdd());

// Every persona that doesn't already start here (elsewhere, or nowhere); the ones that do are the list above,
// so offering them again would be a no-op.
const elsewhere = computed<Persona[]>(() => personas.value.filter((persona) => persona.workspace?.startIn !== dir.value));
const query = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() =>
    query.value === ``
        ? elsewhere.value
        : elsewhere.value.filter((persona) => `${persona.label ?? ``} ${persona.id}`.toLowerCase().includes(query.value)),
);
// Filter earns its place only past a glance-length list, same threshold as the Personas page's account chooser.
const filterable = computed(() => elsewhere.value.length > 6);
const chosenCard = computed(() => personas.value.find((persona) => persona.id === chosen.value));
// Where the chosen card starts today, if anywhere; stated aloud since the folder losing it isn't shown on this screen.
const movedFrom = computed(() => chosenCard.value?.workspace?.startIn);

const cardId = computed(() => (mode.value === `edit` ? editing.value : personaSlug(label.value)) ?? ``);
// A new card can't land on a taken name — save is by id, so it would silently overwrite that other persona.
const taken = computed(() => mode.value === `new` && personas.value.some((persona) => persona.id === cardId.value));
const nameValid = computed(() => cardId.value !== `` && !taken.value);
const valid = computed(() => (mode.value === `existing` ? chosen.value !== undefined : nameValid.value));
const nameHint = computed(() => {
    if (label.value === `` || nameValid.value) {
        return undefined;
    }
    return taken.value ? `You already have a persona called ${cardId.value}.` : `Use letters or digits.`;
});

const heading = computed(() =>
    mode.value === `edit` ? `Editing ${label.value}` : mode.value === `existing` ? `Use an existing persona` : `Add a persona`,
);

// How bounded this draft is, in the app's own phrase; shown beside the collapsed Advanced section so a limited
// card doesn't read as full-powers just because that section is folded away.
const bounds = computed(() => {
    const stored = storedPowers(powers.value);
    return stored === undefined ? undefined : personaBounds({ id: cardId.value, capabilities: [], powers: stored });
});

// Fields this panel never asks about but must not drop when rewriting an existing card: what it's for, its
// prompt mode, its repos, its models — each would otherwise vanish on the first folder change.
const carriedOver = (existing: Persona | undefined): Pick<Persona, "brief" | "systemPromptMode" | "context" | "models"> => ({
    ...(existing?.brief !== undefined ? { brief: existing.brief } : {}),
    ...(existing?.systemPromptMode !== undefined ? { systemPromptMode: existing.systemPromptMode } : {}),
    ...(existing?.context !== undefined ? { context: existing.context } : {}),
    ...(existing?.models !== undefined ? { models: existing.models } : {}),
});

// The whole card about to be written, or undefined until the form describes one. Built here so the two modes'
// shapes sit side by side: moving a card touches one field, writing one spells out every field it owns.
const draftCard = (folder: string): Persona | undefined => {
    if (mode.value === `existing`) {
        const picked = chosenCard.value;
        // A move, not a re-decision: everything but `startIn` stays exactly as the picked card already has it.
        return picked === undefined ? undefined : { ...picked, workspace: { ...picked.workspace, startIn: folder } };
    }
    if (!nameValid.value) {
        return undefined;
    }
    const existing = editing.value === undefined ? undefined : personas.value.find((persona) => persona.id === editing.value);
    const stored = storedPowers(powers.value);
    const named = label.value.trim();
    return {
        id: cardId.value,
        // Carried over, not asked about (see header); a brand-new card starts with no accounts.
        capabilities: existing?.capabilities ?? [],
        ...carriedOver(existing),
        // Only stored when it says something the id doesn't already.
        ...(named !== `` && named !== cardId.value ? { label: named } : {}),
        // Absent means the full toolbox, so an untouched Advanced section commits nothing.
        ...(stored !== undefined ? { powers: stored } : {}),
        // The panel's whole point: the clicked folder, kept alongside anything else the card already said about itself.
        workspace: { ...existing?.workspace, startIn: folder },
    };
};

const submit = async (): Promise<void> => {
    const folder = dir.value;
    const card = folder === undefined ? undefined : draftCard(folder);
    if (card === undefined) {
        return;
    }
    saveError.value = undefined;
    try {
        await save.mutateAsync(card);
        dir.value = undefined;
    } catch (err) {
        saveError.value = noticeFrom(err, `Could not save this persona.`);
    }
};
</script>

<template>
    <!--
        The header asks the folder's question, not claims its contents: "Personas in X" reads as an existing list,
        wrong on the folder's first use. "Who works in …" holds whether the answer is written, borrowed, or edited here.
    -->
    <Modal v-model:open="visible" size="md" :header="`Who works in ${folderName}`">
        <div class="flex flex-col gap-4">
            <p class="text-xs text-subtle">
                A persona that starts here opens its sessions in <code class="ui-code">{{ dir }}</code
                >. Everything else about it can stay as it is.
            </p>

            <!-- Existing cards first, since a folder can hold several; absent entirely (not an empty box) when there are none. -->
            <div v-if="cards.length > 0" class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">Starting here</span>
                <div
                    v-for="persona in cards"
                    :key="persona.id"
                    class="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors"
                    :class="editing === persona.id ? `border-link bg-link/10` : `border-line`"
                >
                    <!-- Smaller than a persona-focused list; this panel is about the folder, not about showing cards off. -->
                    <PersonaFace :persona :size="32" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ persona.label ?? persona.id }}</span>
                    <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                    <button type="button" :class="ui.iconButton()" :aria-label="`Edit ${persona.label ?? persona.id}`" @click="startEdit(persona)">
                        <Icon name="pencil" class="text-xs" />
                    </button>
                </div>
            </div>

            <!-- Only drawn when there are cards above to separate from; alone, a rule under one paragraph reads as a load failure. -->
            <div class="flex flex-col gap-3" :class="cards.length > 0 ? `border-t border-line pt-4` : ``">
                <div class="flex items-center gap-2">
                    <span :class="ui.sectionLabel()">{{ heading }}</span>
                    <!--
                        Always the same corner, and only ever one link at a time — two side by side would turn this into a three-way
                        choice. Set off from the heading, or it reads as a continuation of the uppercase label.
                    -->
                    <button
                        v-if="mode !== `new`"
                        type="button"
                        :class="ui.linkButton('ml-auto text-xs text-muted hover:text-content')"
                        @click="startAdd"
                    >
                        Add a new one instead
                    </button>
                    <button
                        v-else-if="elsewhere.length > 0"
                        type="button"
                        :class="ui.linkButton('ml-auto text-xs text-muted hover:text-content')"
                        @click="startExisting"
                    >
                        Use one I already have
                    </button>
                </div>

                <!--
                    Rows styled like the ones above on purpose — same kind of thing, one folder along. Each names where it
                    starts today, since that's what picking it here takes away.
                -->
                <template v-if="mode === `existing`">
                    <input v-if="filterable" v-model="filter" :class="ui.input('w-full')" placeholder="Find a persona…" aria-label="Find a persona" />
                    <div class="flex max-h-56 flex-col gap-1 overflow-y-auto">
                        <button
                            v-for="persona in shown"
                            :key="persona.id"
                            type="button"
                            class="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors"
                            :class="chosen === persona.id ? `border-link bg-link/10` : `border-line hover:border-line-strong`"
                            :aria-label="`Start ${persona.label ?? persona.id} here`"
                            :aria-pressed="chosen === persona.id"
                            @click="chosen = persona.id"
                        >
                            <PersonaFace :persona :size="32" />
                            <span class="min-w-0 flex-1 truncate text-sm text-content">{{ persona.label ?? persona.id }}</span>
                            <span class="max-w-[45%] shrink-0 truncate text-xs text-subtle">
                                {{ persona.workspace?.startIn === undefined ? `no starting folder` : `starts in ${persona.workspace.startIn}` }}
                            </span>
                            <Icon v-if="chosen === persona.id" name="check" class="shrink-0 text-xs text-link" />
                        </button>
                        <p v-if="shown.length === 0" class="px-0.5 py-1 text-xs text-subtle">No persona goes by that.</p>
                    </div>
                    <!-- Stated in words too, since the folder that loses the card isn't shown on this screen. -->
                    <p v-if="movedFrom !== undefined" class="text-xs text-warning">
                        This moves it: <span class="font-medium">{{ chosenCard?.label ?? chosenCard?.id }}</span> starts in
                        <code class="ui-code">{{ movedFrom }}</code> today, and a persona has one starting folder.
                    </p>
                </template>

                <template v-else>
                    <div class="ui-field">
                        <input
                            v-model="label"
                            :class="ui.input('w-full font-medium')"
                            :placeholder="`Name this persona: ${folderName}, Docs bot, Refactor crew…`"
                            aria-label="Name"
                            autofocus
                            @keyup.enter="valid && submit()"
                        />
                        <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
                    </div>

                    <!--
                        Folded, since most cards keep the full toolbox; the badge keeps a limited card visible even closed.
                        Absent while picking an existing card — that mode moves a persona without re-deciding anything about it.
                    -->
                    <div class="flex flex-col gap-3">
                        <div class="flex items-center gap-2">
                            <button
                                type="button"
                                :class="ui.linkButton('gap-1.5 text-xs text-muted hover:text-content')"
                                :aria-expanded="advanced"
                                @click="advanced = !advanced"
                            >
                                <Icon name="angle-right" class="transition-transform" :class="advanced ? `rotate-90` : ``" />
                                Advanced: what it may do
                            </button>
                            <StatusBadge v-if="bounds !== undefined" variant="neutral" size="xs">{{ bounds }}</StatusBadge>
                        </div>
                        <PersonaPowersFields v-if="advanced" :draft="powers" :grantables="grantables" />
                    </div>
                </template>

                <Notice v-if="saveError !== undefined" :of="saveError" />
            </div>
        </div>

        <template #footer>
            <!-- The rest of a card lives on the page that owns it; this link is the way there, not a second copy of it. -->
            <RouterLink to="/sandbox/personas" :class="ui.linkButton('mr-auto gap-1 text-xs text-muted hover:text-content')">
                Full editor <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button label="Cancel" text size="small" @click="dir = undefined" />
            <!-- The verb follows the mode, so the button never promises "add" while the panel is actually moving a card. -->
            <Button
                :label="mode === `new` ? `Add persona` : mode === `existing` ? `Start here` : `Save`"
                size="small"
                :loading="save.isPending.value"
                :disabled="!valid"
                @click="submit"
            >
                <template #icon><Icon :name="mode === `new` ? `plus` : `check`" /></template>
            </Button>
        </template>
    </Modal>
</template>
