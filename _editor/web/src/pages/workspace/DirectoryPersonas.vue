<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { Avatar, cmp, Notice, type NoticeModel, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { identityHue } from "../../composables/identityHue";
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

/* A FOLDER'S PERSONAS, FROM THE FOLDER — opened by the person icon on a directory row in the Workspace tree.
 *
 * The Personas page is where a card is thought about: which accounts it speaks through, and everything it may do.
 * This is the other half of the same feature and a different question — "give me a persona that works HERE" —
 * asked in the place where the answer is obvious, with the starting path filled in from the row that was clicked
 * rather than typed into a text field on another page. So it asks for a name and stops, and the switches that
 * most cards never touch are folded under Advanced.
 *
 * A FOLDER HOLDS SEVERAL, which is why this is a list and not a toggle: "Docs bot" and "Refactor crew" can both
 * start in the same repo with different bounds, and a panel that showed one card would silently edit the wrong one.
 *
 * THE FORM IS ALWAYS THERE, below whatever is already here, because both things people arrive wanting to do are
 * then one click away — add another, or edit one — and neither is behind a mode the panel has to be put into.
 *
 * The save is a whole-card upsert, so an edit carries over every field this panel does not ask about. Leaving
 * `capabilities` out of a card that had two accounts would not "not change them"; it would take them away. */

const dir = defineModel<string | undefined>({ required: true });

const { personas, save } = usePersonas();
const { capabilities } = useCapabilities();
const grantables = computed(() => grantablesFrom(capabilities.value));

// The dialog is open exactly when there is a folder to be open ABOUT — one piece of state, so there is no way to
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

// ── The form ────────────────────────────────────────────────────────────────────────────────────────────────
// `editing` is the id of the card being changed, or undefined while writing a new one — which decides the id, the
// name check and the verb on the button.
const editing = ref<string | undefined>(undefined);
const label = ref(``);
const powers = ref<PersonaPowersDraft>({ ...FULL_POWERS });
const advanced = ref(false);
const saveError = ref<NoticeModel | undefined>(undefined);

const startAdd = (): void => {
    editing.value = undefined;
    label.value = ``;
    powers.value = { ...FULL_POWERS };
    advanced.value = false;
    saveError.value = undefined;
};
const startEdit = (persona: Persona): void => {
    editing.value = persona.id;
    label.value = persona.label ?? persona.id;
    powers.value = powersDraftOf(persona);
    // Opened for whoever came to change the bounds, since on an existing card that is usually why — and it is
    // where the card's own answers are, which a collapsed section would hide behind a click.
    advanced.value = persona.powers !== undefined;
    saveError.value = undefined;
};

// A second folder must not inherit the first one's half-typed name, and a previous failure must not greet a
// fresh open.
watch(dir, () => startAdd());

const cardId = computed(() => editing.value ?? personaSlug(label.value));
// A new card may not land on a name already taken — the save is by id, so it would silently rewrite that card
// instead, including one belonging to another folder entirely.
const taken = computed(() => editing.value === undefined && personas.value.some((persona) => persona.id === cardId.value));
const valid = computed(() => cardId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (label.value === `` || valid.value) {
        return undefined;
    }
    return taken.value ? `You already have a persona called ${cardId.value}.` : `Use letters or digits.`;
});

/* How bounded this draft is, in the phrase the rest of the app uses — shown beside the collapsed Advanced
 * section, because a card someone limited last week must not read as a full-powers card just because the section
 * holding that fact is folded away. */
const bounds = computed(() => {
    const stored = storedPowers(powers.value);
    return stored === undefined ? undefined : personaBounds({ id: cardId.value, capabilities: [], powers: stored });
});

const submit = async (): Promise<void> => {
    const folder = dir.value;
    if (folder === undefined || !valid.value) {
        return;
    }
    saveError.value = undefined;
    const existing = editing.value === undefined ? undefined : personas.value.find((persona) => persona.id === editing.value);
    const stored = storedPowers(powers.value);
    const named = label.value.trim();
    try {
        await save.mutateAsync({
            id: cardId.value,
            // Carried over, not asked about — see the header. A new card starts with no accounts, which is what a
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
        });
        dir.value = undefined;
    } catch (err) {
        saveError.value = noticeFrom(err, `Could not save this persona.`);
    }
};
</script>

<template>
    <Dialog
        v-model:visible="visible"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :header="`Personas in ${folderName}`"
        :style="{ width: '32rem', maxWidth: '95vw' }"
        :pt="{ content: { class: `max-h-[70dvh] overflow-y-auto` } }"
    >
        <div class="flex flex-col gap-4">
            <!-- One sentence, and it is about this folder rather than about personas in general. -->
            <p class="text-xs text-subtle">
                A persona that starts here opens its sessions in <code class="ui-code">{{ dir }}</code
                >. Everything else about it can stay as it is.
            </p>

            <!-- WHAT IS ALREADY HERE, first — a folder can hold several, and the card you meant to change is one
                 of them. Absent entirely on a folder with none, rather than an empty box saying so: the form
                 below already reads as "there is nothing here yet, name one". -->
            <div v-if="cards.length > 0" class="flex flex-col gap-1">
                <span :class="cmp.sectionLabel()">Starting here</span>
                <div
                    v-for="persona in cards"
                    :key="persona.id"
                    class="flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors"
                    :class="editing === persona.id ? `border-link bg-link/10` : `border-line`"
                >
                    <Avatar :size="24" :name="persona.label ?? persona.id" :hue="identityHue(persona.id)" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ persona.label ?? persona.id }}</span>
                    <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                    <button type="button" :class="cmp.iconButton()" :aria-label="`Edit ${persona.label ?? persona.id}`" @click="startEdit(persona)">
                        <Icon name="pencil" class="text-xs" />
                    </button>
                </div>
            </div>

            <!-- The rule separates the form from the cards above it, so on a folder with none there is nothing for
                 it to separate — and a line under a lone paragraph reads as a section whose contents failed to
                 load. -->
            <div class="flex flex-col gap-3" :class="cards.length > 0 ? `border-t border-line pt-4` : ``">
                <div class="flex items-center gap-2">
                    <span :class="cmp.sectionLabel()">{{ editing === undefined ? `Add a persona` : `Editing ${label}` }}</span>
                    <!-- The way back out of edit mode, next to the thing it undoes. -->
                    <button
                        v-if="editing !== undefined"
                        type="button"
                        :class="cmp.linkButton('text-xs text-muted hover:text-content')"
                        @click="startAdd"
                    >
                        Add a new one instead
                    </button>
                </div>

                <div class="ui-field">
                    <input
                        v-model="label"
                        :class="cmp.input('w-full font-medium')"
                        :placeholder="`Name this persona — ${folderName}, Docs bot, Refactor crew…`"
                        aria-label="Name"
                        autofocus
                        @keyup.enter="valid && submit()"
                    />
                    <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
                </div>

                <!-- PERMISSIONS, FOLDED. Every card gets the full toolbox unless somebody says otherwise, so this
                     is the section most people never open — and the badge is what keeps that safe: a card that IS
                     limited says so on the closed section. -->
                <div class="flex flex-col gap-3">
                    <div class="flex items-center gap-2">
                        <button
                            type="button"
                            :class="cmp.linkButton('gap-1.5 text-xs text-muted hover:text-content')"
                            :aria-expanded="advanced"
                            @click="advanced = !advanced"
                        >
                            <Icon name="angle-right" class="transition-transform" :class="advanced ? `rotate-90` : ``" />
                            Advanced — what it may do
                        </button>
                        <StatusBadge v-if="bounds !== undefined" variant="neutral" size="xs">{{ bounds }}</StatusBadge>
                    </div>
                    <PersonaPowersFields v-if="advanced" :draft="powers" :grantables="grantables" />
                </div>

                <Notice v-if="saveError !== undefined" :of="saveError" />
            </div>
        </div>

        <template #footer>
            <!-- The rest of a card — the accounts it speaks through, the folders it is fenced to — lives on the
                 page that owns it, and this is the way there rather than a second copy of it. -->
            <RouterLink to="/sandbox/personas" :class="cmp.linkButton('mr-auto gap-1 text-xs text-muted hover:text-content')">
                Full editor <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button label="Cancel" text size="small" @click="dir = undefined" />
            <Button
                :label="editing === undefined ? `Add persona` : `Save`"
                size="small"
                :loading="save.isPending.value"
                :disabled="!valid"
                @click="submit"
            >
                <template #icon><Icon :name="editing === undefined ? `plus` : `check`" /></template>
            </Button>
        </template>
    </Dialog>
</template>
