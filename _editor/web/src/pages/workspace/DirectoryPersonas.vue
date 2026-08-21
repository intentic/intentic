<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { ui, Modal, Notice, type NoticeModel, PersonaFace, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref, watch } from "vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import {
    FULL_POWERS,
    grantablesFrom,
    type PersonaPowersDraft,
    personaSlug,
    personasStartingIn,
    powersDraftOf,
    storedPowers,
} from "../../composables/sandbox/personaCard";
import { usePersonas } from "../../composables/sandbox/usePersonas";
import PersonaPowersFields from "../sandbox/PersonaPowersFields.vue";

/* WHO WORKS IN THIS FOLDER: opened by the person icon on a directory row in the Workspace tree.
 *
 * The Personas page is where a card is thought about: which accounts it speaks through, and everything it may do.
 * This is the other half of the same feature and a different question ("who works HERE") asked in the place
 * where the answer is obvious, with the starting path taken from the row that was clicked rather than typed into
 * a text field on another page.
 *
 * THAT QUESTION HAS THREE ANSWERS, and the panel is one question with three ways to answer it rather than three
 * panels: write a new card that starts here, point a card you ALREADY have at this folder, or change one of the
 * cards already starting here. The second one is why the panel is not called "Add a persona": somebody who has
 * built "Docs bot" once should not have to build it again to make it work in a second repo, and before this the
 * only route was the Personas page plus retyping the path by hand.
 *
 * A PERSONA HAS ONE STARTING FOLDER, so pointing an existing card here MOVES it. The picker says where each card
 * starts today and the panel says so again once one is chosen, because that is a change to a persona somebody
 * else's automation may be pinned to, and it is invisible everywhere except the folder it left.
 *
 * A FOLDER HOLDS SEVERAL, which is why this is a list and not a toggle: "Docs bot" and "Refactor crew" can both
 * start in the same repo with different bounds, and a panel that showed one card would silently edit the wrong one.
 *
 * THE FORM IS ALWAYS THERE, below whatever is already here, because everything people arrive wanting to do is then
 * one click away and none of it is behind a mode the panel has to be put into first.
 *
 * The save is a whole-card upsert, so an edit carries over every field this panel does not ask about. Leaving
 * `capabilities` out of a card that had two accounts would not "not change them"; it would take them away. */

const dir = defineModel<string | undefined>({ required: true });

const { personas, save } = usePersonas();
const { capabilities } = useCapabilities();
const grantables = computed(() => grantablesFrom(capabilities.value));

// The dialog is open exactly when there is a folder to be open ABOUT: one piece of state, so there is no way to
// be open over no folder or closed over one.
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

/* ── The form ────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WHICH OF THE THREE ANSWERS is being given, as one piece of state, because every other thing on screen follows
 * from it: the heading, whether there is a name field or a picker, and the verb on the button. `editing` and
 * `chosen` each belong to exactly one mode and are cleared entering any other, so there is no way to submit a
 * name while a picked card is still remembered underneath. */
type Mode = `new` | `existing` | `edit`;
const mode = ref<Mode>(`new`);
// The id of the card being changed (edit), and the id of the card being pointed at this folder (existing).
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
    // Opened for whoever came to change the bounds, since on an existing card that is usually why, and it is
    // where the card's own answers are, which a collapsed section would hide behind a click.
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

// A second folder must not inherit the first one's half-typed name, and a previous failure must not greet a
// fresh open.
watch(dir, () => startAdd());

/* ── Pointing a card you already have at this folder ─────────────────────────────────────────────────────────
 *
 * Every persona that does not already start here, whether it starts somewhere else or nowhere at all. The ones
 * that DO start here are the list above; offering them again would be an action that changes nothing. */
const elsewhere = computed<Persona[]>(() => personas.value.filter((persona) => persona.workspace?.startIn !== dir.value));
const query = computed(() => filter.value.trim().toLowerCase());
const shown = computed(() =>
    query.value === ``
        ? elsewhere.value
        : elsewhere.value.filter((persona) => `${persona.label ?? ``} ${persona.id}`.toLowerCase().includes(query.value)),
);
// The filter earns its place only once the list is longer than a glance: the same rule the account chooser on
// the Personas page follows.
const filterable = computed(() => elsewhere.value.length > 6);
const chosenCard = computed(() => personas.value.find((persona) => persona.id === chosen.value));
/* Where the chosen card starts TODAY, when that is somewhere. A card has one starting folder, so this action
 * takes it off that one, which the panel has to say out loud, because the folder losing it is not on screen. */
const movedFrom = computed(() => chosenCard.value?.workspace?.startIn);

const cardId = computed(() => (mode.value === `edit` ? editing.value : personaSlug(label.value)) ?? ``);
// A new card may not land on a name already taken: the save is by id, so it would silently rewrite that card
// instead, including one belonging to another folder entirely.
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

/* How bounded this draft is, in the phrase the rest of the app uses: shown beside the collapsed Advanced
 * section, because a card someone limited last week must not read as a full-powers card just because the section
 * holding that fact is folded away. */
const bounds = computed(() => {
    const stored = storedPowers(powers.value);
    return stored === undefined ? undefined : personaBounds({ id: cardId.value, capabilities: [], powers: stored });
});

/* THE WHOLE CARD THIS PANEL IS ABOUT TO WRITE, or undefined when the form does not describe one yet. Built here
 * rather than inline in the handler so the two shapes sit side by side: the mode that only moves a card touches
 * exactly one field of it, and the mode that writes one spells out every field it is responsible for. */
const draftCard = (folder: string): Persona | undefined => {
    if (mode.value === `existing`) {
        const picked = chosenCard.value;
        /* A MOVE, not a re-decision. Everything except where it starts is the card exactly as it stands: its
         * accounts, its powers, the projects that prefer it, because the only thing this mode asked about was
         * the folder. */
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
        // Carried over, not asked about: see the header. A new card starts with no accounts, which is what a
        // persona created to work in a folder rather than to post as somebody wants.
        capabilities: existing?.capabilities ?? [],
        ...(existing?.repos !== undefined ? { repos: existing.repos } : {}),
        // Only worth storing when it says something the id does not.
        ...(named !== `` && named !== cardId.value ? { label: named } : {}),
        // Absent means the full toolbox, so an untouched Advanced section commits nothing.
        ...(stored !== undefined ? { powers: stored } : {}),
        // The whole point of the panel: the row that was clicked, kept alongside whatever else the card
        // already said about where it works.
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
    <!-- THE HEADER IS THE FOLDER'S QUESTION, not a claim about its contents. "Personas in knowledge" read as a
         list of cards that live in that folder, and said it over an empty panel on every folder that has none,
         which is exactly the folder somebody opens this from the first time. "Who works in …" is what the panel
         is FOR, and it stays true whether the answer gets written here, borrowed from a card that already
         exists, or changed. -->
    <Modal v-model:open="visible" size="md" :header="`Who works in ${folderName}`">
        <div class="flex flex-col gap-4">
            <!-- One sentence, and it is about this folder rather than about personas in general. -->
            <p class="text-xs text-subtle">
                A persona that starts here opens its sessions in <code class="ui-code">{{ dir }}</code
                >. Everything else about it can stay as it is.
            </p>

            <!-- WHAT IS ALREADY HERE, first: a folder can hold several, and the card you meant to change is one
                 of them. Absent entirely on a folder with none, rather than an empty box saying so: the form
                 below already reads as "there is nothing here yet, name one". -->
            <div v-if="cards.length > 0" class="flex flex-col gap-1">
                <span :class="ui.sectionLabel()">Starting here</span>
                <div
                    v-for="persona in cards"
                    :key="persona.id"
                    class="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors"
                    :class="editing === persona.id ? `border-link bg-link/10` : `border-line`"
                >
                    <!-- Smaller than the lists that exist to show personas off: this panel is about a FOLDER,
                         and these are the cards that happen to start in it. -->
                    <PersonaFace :persona :size="32" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ persona.label ?? persona.id }}</span>
                    <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                    <button type="button" :class="ui.iconButton()" :aria-label="`Edit ${persona.label ?? persona.id}`" @click="startEdit(persona)">
                        <Icon name="pencil" class="text-xs" />
                    </button>
                </div>
            </div>

            <!-- The rule separates the form from the cards above it, so on a folder with none there is nothing for
                 it to separate, and a line under a lone paragraph reads as a section whose contents failed to
                 load. -->
            <div class="flex flex-col gap-3" :class="cards.length > 0 ? `border-t border-line pt-4` : ``">
                <div class="flex items-center gap-2">
                    <span :class="ui.sectionLabel()">{{ heading }}</span>
                    <!-- THE OTHER WAY TO ANSWER, always at the same end of the same row: a mode switch a reader
                         has to hunt for is one they use once. Only ever one link: two side by side would make a
                         three-way choice out of a form that is already showing which choice it is on. And it is
                         pushed off the heading, which reads as a continuation of it when it sits flush against
                         an uppercase label. -->
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

                <!-- ONE OF YOUR CARDS, POINTED HERE. The rows read like the ones above them on purpose: it is the
                     same kind of thing, one folder along. Each says where it starts TODAY, because that is what
                     picking it takes away: a persona has one starting folder, so this moves it. -->
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
                    <!-- Said again, in words, once there is something to say it about. The folder that loses the
                         card is not on this screen, and a move nobody meant is only noticed there. -->
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

                    <!-- PERMISSIONS, FOLDED. Every card gets the full toolbox unless somebody says otherwise, so
                         this is the section most people never open, and the badge is what keeps that safe: a card
                         that IS limited says so on the closed section. (Absent while picking an existing card:
                         that mode moves a persona and re-decides nothing about it.) -->
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
            <!-- The rest of a card (the accounts it speaks through, the folders it is fenced to) lives on the
                 page that owns it, and this is the way there rather than a second copy of it. -->
            <RouterLink to="/sandbox/personas" :class="ui.linkButton('mr-auto gap-1 text-xs text-muted hover:text-content')">
                Full editor <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button label="Cancel" text size="small" @click="dir = undefined" />
            <!-- The verb is the mode's, so the button never promises to add a persona while the panel is moving
                 one. "Start here" is true of a card that had a folder and of one that had none. -->
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
