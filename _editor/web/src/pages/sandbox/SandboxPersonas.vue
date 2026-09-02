<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import {
    Avatar,
    BrandMark,
    Button,
    ui,
    ConfirmDialog,
    DisclosureRow,
    Notice,
    type NoticeModel,
    PersonaFace,
    RowGroup,
    RowNote,
    SkeletonRows,
    StatusBadge,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import PersonaForm, { type PersonaDraft } from "./PersonaForm.vue";
import { createInlineRename } from "../../composables/inlineRename";
import { useBrowserAccounts } from "../../composables/extensions/useBrowserAccounts";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { grantablesFrom, type PersonaGrantable, personaSlug, powersDraftOf, storedPowers } from "../../composables/sandbox/personaCard";
import { usePersonas } from "../../composables/sandbox/usePersonas";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";

/* THE PERSONAS this sandbox wears when it acts outside, and the one place a WHOLE card is written: the accounts
 * it speaks through, what it may do, where it works. (A folder's own personas can also be named and bounded from
 * the Workspace tree's row icon; that panel asks for a name and links here for the rest. Both write through
 * personaCard.ts.)
 *
 * A persona is NOT per-site. It is a person the outside world reads: "Work" holds its Reddit account AND its X
 * account AND whatever else belongs to that person, so one card can span every platform the owner signed into
 * under that name. That is the whole reason the layer exists: the accounts already live one-per-login in the
 * capability manifest, and what was missing was anything saying which of them are the same someone.
 *
 * It lives in the sandbox hub rather than beside the accounts on /capabilities because it is a property of the
 * BOX, shared by every chat and every automation in it, not a detail of one connection. The accounts page
 * answers "what is this sandbox signed into"; this answers "who is it".
 *
 * Under "Reach" and pointedly not under "Configuration", where the AI-account row lives: those two are one
 * letter apart in English and opposite in consequence, which subscription PAYS for a turn versus whose name is
 * on what it posts, and putting them in the same group is how someone eventually gets the billing right and
 * the Reddit wrong. */

const { personas, connected, isConnected, error, isLoading, save, remove } = usePersonas();
const outline = useSandboxOutline(isLoading);
// The list query reports a bare message; this page knows the user came to see their personas.
const listNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your personas.`, detail: error.value },
);
// The accounts a card can name: the logged-in browser profiles, each carrying the brand of the site it is an
// account of. One capability = one account, so a site the owner connected twice appears twice and exactly one
// of them belongs on any given card.
const { accounts, accountOf } = useBrowserAccounts();

// The other three things a card grants by id: see grantablesFrom, shared with the Workspace tree's quick panel.
const { capabilities } = useCapabilities();
const grantables = computed<PersonaGrantable[]>(() => grantablesFrom(capabilities.value));

/* The marks a row shows for the accounts its card names: the fastest way to read that a persona spans two
 * sites, and the reason the row does not spell them out in a comma-joined line. An id the manifest has no
 * capability for still gets an entry: a card may name an account nobody has added HERE, and dropping it would
 * make the row claim a persona reaches less than it was written to. */
const marks = (persona: Persona) => persona.capabilities.map((id) => ({ id, account: accountOf(id), signedIn: isConnected(id) }));

/* Whether a card can act AT ALL right now. A persona naming three accounts with one signed in is still usable:
 * the turn simply reaches the one, so this marks only the persona that can reach nothing, which is every one
 * of them on a workspace someone has just cloned and the state a surface must not paint as working. */
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

/* ── The editor ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * AN ACCORDION OVER A SETTINGS OBJECT, and the two rules that follow from calling it that.
 *
 * A persona is settings, not a document: nine switches, two folder answers and a list of accounts, each of which
 * means something on its own. So an OPEN card writes as you change it: flip a switch and it is flipped, the way
 * every settings surface people already use behaves, and there is no Save button to leave a card half-decided
 * behind.
 *
 * The row is the disclosure. There is no pencil-to-edit mode: the thing you click to see a card is the thing you
 * click to change it, which is one affordance instead of two and the pattern the Environment tab already uses.
 * The NAME is not in the panel at all: it stays the row's own title, text until you click it (inlineRename). */
const draft = ref<PersonaDraft | undefined>(undefined);
const saveError = ref<NoticeModel | undefined>(undefined);

const draftOf = (persona: Persona): PersonaDraft => ({
    original: persona.id,
    label: persona.label ?? persona.id,
    capabilities: [...persona.capabilities],
    ...powersDraftOf(persona),
    // One folder or none, carried as a list because that is what the picker models either way.
    startIn: persona.workspace?.startIn === undefined ? [] : [persona.workspace.startIn],
    folders: [...(persona.workspace?.folders ?? [])],
    systemPromptMode: persona.systemPromptMode,
});

/* Changing the draft without the autosave below reading it as an edit: installing one on open, and writing a
 * committed rename back into it. Both are the app catching the draft UP to the truth, and a save fired for
 * either would be a write nobody asked for (and, on open, a write of every card the user merely looked at). */
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

/* ── Making one ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * A NAME, AND NOTHING ELSE. Creating a persona used to open the whole editor with a Create button under it, so
 * the first thing this page ever asked a new user was thirty questions about a thing that did not exist yet:
 * which accounts it speaks through, nine permissions, two folders, a system prompt. Almost every answer is a
 * default, and the one that is not is the name.
 *
 * So it is one field. The card is written with the defaults the schema already means (full toolbox, whole
 * workspace, the sandbox's prompt: all of which it stores as ABSENT, so the committed file says nothing about
 * questions nobody was asked), and then the new card OPENS, which is where the rest is set at leisure with the
 * row's own title above it saying what is being edited.
 *
 * The name lives in its own ref rather than in a half-built draft: a draft with no `original` was a card that
 * did not exist wearing the type of one that did, and every field on it was optional-until-saved in a way the
 * editor had to keep re-checking. */
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
// A new card may not land on a name already taken: saving would silently edit the other one instead.
const taken = computed(() => personas.value.some((persona) => persona.id === newId.value));
const newValid = computed(() => newId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (newName.value === undefined || newName.value === `` || newValid.value) {
        return undefined;
    }
    return taken.value ? `You already have a persona called ${newId.value}.` : `Use letters or digits.`;
});

/* WHAT IS WORTH STORING. A card that grants everything stores no `powers` at all, and one that limits nothing
 * stores no `workspace`, so the committed file stays a description of the DECISIONS somebody made rather than a
 * dump of every default, and a diff on it reads as the change it was.
 *
 * That is the same rule the label follows, applied to two objects instead of a field. The powers half lives in
 * personaCard.ts, because the tree's quick panel writes cards too and two copies of this rule is two answers to
 * "was anything actually decided here". */
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
        // Same rule as the two above: a card following the sandbox stores nothing, so the file says what was
        // decided rather than restating a default nobody chose.
        ...(state.systemPromptMode !== undefined ? { systemPromptMode: state.systemPromptMode } : {}),
    };
};

/* CREATE, THEN OPEN. The card is written with nothing on it but its name and an empty account list: every
 * other answer is a default the schema already means, and storing them would put a decision nobody made into a
 * tracked file. Then the new card opens, because "made a persona" and "now set it up" are one errand and the
 * editor is where the second half happens. */
const submit = async (): Promise<void> => {
    if (!newValid.value) {
        return;
    }
    const id = newId.value;
    const label = (newName.value ?? ``).trim();
    saveError.value = undefined;
    try {
        await save.mutateAsync({ id, capabilities: [], ...(label !== id ? { label } : {}) });
        newName.value = undefined;
        // Quietly, like any other open: the autosave watcher must not read a card being SHOWN as a card being
        // edited and write back the row it just created.
        quietly(() => {
            draft.value = draftOf({ id, capabilities: [], ...(label !== id ? { label } : {}) });
        });
    } catch (err) {
        saveError.value = noticeFrom(err, `Could not save this persona.`);
    }
};

/* The live half. Debounced because a folder picked from the tree and a switch flipped twice while deciding are
 * each several mutations of one intent, and a write per keystroke-equivalent would put a card's every
 * intermediate state into a tracked file. Long enough to coalesce a decision, short enough that the spinner
 * beside the name has stopped by the time attention moves on. */
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

/* ── The name ────────────────────────────────────────────────────────────────────────────────────────────────
 * One state machine for the whole list rather than one per row: only ever one name is being typed, and a factory
 * inside a v-for would build (and throw away) one for every persona on every render.
 *
 * A rename writes the WHOLE card, because the save is an upsert, and it reads that card from the open draft
 * when there is one, so a rename lands on top of switches flipped a second ago rather than on the version the
 * list was last told about. The id is frozen either way: automations pin to it, so only the label moves. */
const renamingId = ref<string | undefined>(undefined);
const renameTarget = computed(() => personas.value.find((persona) => persona.id === renamingId.value));
const rename = createInlineRename(
    () => renameTarget.value?.label ?? renamingId.value,
    async (name) => {
        const id = renamingId.value;
        if (id === undefined) {
            return;
        }
        const open = draft.value?.original === id ? draft.value : undefined;
        await save.mutateAsync(open !== undefined ? { ...cardFrom(open), label: name } : { ...renameTarget.value!, label: name });
        if (open !== undefined) {
            quietly(() => {
                open.label = name;
            });
        }
    },
    `Couldn't rename this persona.`,
);
const beginRename = (persona: Persona): void => {
    renamingId.value = persona.id;
    rename.begin();
};

// ── Removal ─────────────────────────────────────────────────────────────────────────────────────────────────
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
        <!-- One sentence. The rest of what a persona is: that it spans sites, that the names travel and the
             logins don't: is shown by the surface itself rather than explained above it. -->
        <p class="mb-5 max-w-2xl text-sm text-muted">
            A persona is who this sandbox is when it works: the accounts it speaks through, what it may do, and where in the workspace it works. Point
            an automation at one and it runs inside those bounds.
        </p>

        <Notice v-if="listNotice" :of="listNotice" class="mb-4" />
        <!-- The empty state below is a real one: it explains what NOT having a persona costs, so it must not
             be shown to somebody who simply has not been told yet. The list's own shape stands in meanwhile. -->
        <!-- The outline is a <RowGroup> like the list it stands in for, so it lands on the same tier by
             construction. It used to state its own: the rows arrived compact, the placeholder had promised
             comfortable ones, and the list visibly shrank as it landed. -->
        <template v-if="isLoading">
            <RowGroup v-if="outline" label="Your personas">
                <div role="status" aria-busy="true">
                    <span class="sr-only">Reading your sandbox's personas…</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>
        </template>

        <template v-else>
            <!-- NO ACCOUNTS CONNECTED IS NOT A PROBLEM WITH THIS PAGE. It used to open with a warning saying a
                 persona needs one to speak through, which is not true: a card that names a folder and bounds
                 what an agent may touch is a whole persona on its own, and most cards start that way. The way
                 to connect an account is on the Capabilities page, where somebody who wants one is already
                 headed; it does not have to be shouted from here. -->

            <!-- NO PERSONAS AND NOTHING BEING WRITTEN gets a real empty state rather than a group with one line
                 of apology in it. It says what is true right now: automations are mute, chats are unrestricted
                , because that is the consequence someone is here to change, and offers the one action. -->
            <div v-if="personas.length === 0 && newName === undefined" :class="ui.emptyState('flex flex-col items-center gap-3 py-8')">
                <Avatar :size="40" />
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium text-content">No personas yet</span>
                    <span class="max-w-md text-xs text-muted">
                        Until there is one, an automation you schedule can't post anywhere, and a chat reaches every account you've connected.
                    </span>
                </div>
                <!-- Never disabled on "you have no accounts". A card with none is a card that bounds where an
                     agent works and what it may do, which is most of what a persona is for. -->
                <Button label="Add a persona" size="small" @click="startAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <RowGroup v-else label="Your personas" :count="personas.length > 0 ? personas.length : undefined">
                <template #actions>
                    <Button
                        v-if="personas.length > 0 && newName === undefined"
                        label="Add a persona"
                        size="small"
                        severity="secondary"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <!-- THE ROW IS THE DISCLOSURE. Clicking it opens the card in place; there is no second
                     affordance meaning the same thing, which is what the pencil used to be.

                     `hit="row"` is what that costs and what it now also buys. It cannot be `header` — the name
                     is itself a control (click it to rename), and a <button> inside a <button> is invalid and
                     unusable. It is not `pair` either, because shrinking the target to the chevron and the face
                     would take away the gesture people actually use. So the whole row keeps the click, every
                     control on it keeps its `@click.stop`, and the chevron-and-face pair is a real <button> for
                     the first time: opening a card used to be reachable by pointer only. The CARD needs no
                     guard of its own any more — a `drawer` body sits outside the row's handler. -->
                <DisclosureRow
                    v-for="persona in personas"
                    :key="persona.id"
                    hit="row"
                    body="drawer"
                    :open="isOpen(persona)"
                    @update:open="toggleOpen(persona)"
                >
                    <!-- A persona is a person, so it gets a person's face in full colour (PersonaFace holds
                         that). THE FACE IS A ROW'S MARK HERE, NOT A CARD'S SUBJECT: this is a record list, one
                         tab along from the extensions and environment lists. The rail draws faces at 56 for its
                         cards; a row's mark is the ROW TIER'S size, which is the same 22 those neighbouring
                         lists give their BrandMarks.

                         It used to be 32, under a comment claiming both 32 and 22 in one sentence — which is
                         what a number typed at a call site turns into once two surfaces disagree. A round face
                         does read a shade smaller than a square plate at the same box, and that is real, but
                         paying for it costs a second number and a rule about when it applies, which is how 32
                         got here. One size per tier, handed out as `mark`, nothing to remember.

                         The disclosure arrow rides in front of the face, where a reader looks for one, rather
                         than in the row's trailing cluster, which is where facts and actions live. It is
                         <DisclosureRow>'s arrow now: this file drew a `chevron-down`/`chevron-right` swap, two
                         files away another drew `chevron-right` + `rotate-90`, and they were the same control.
                         It is also a real button now, so the face is where a keyboard gets in. -->
                    <template #lead="{ mark }">
                        <PersonaFace :persona :size="mark" />
                    </template>

                    <!-- THE NAME READS AS A NAME until you ask to change it: click-to-rename, on the app's one
                         inline-rename machine (enter commits, escape cancels, blur commits, unchanged is a
                         silent cancel). An input parked here permanently would make a settings list look like a
                         form and put a text box where every other row in the app has a title. -->
                    <template #title>
                        <input
                            v-if="rename.editing && renamingId === persona.id"
                            v-model="rename.draft"
                            :class="ui.inputSm('w-full max-w-xs font-medium')"
                            aria-label="Name"
                            @vue:mounted="rename.focusInput"
                            @click.stop
                            @keydown.enter="rename.commit"
                            @keydown.esc="rename.cancel"
                            @blur="rename.blurCommit"
                        />
                        <button
                            v-else
                            type="button"
                            class="cursor-text rounded px-1 py-0.5 text-left font-medium transition-colors -mx-1 hover:bg-overlay"
                            :aria-label="`Rename ${persona.label ?? persona.id}`"
                            @click.stop="beginRename(persona)"
                        >
                            {{ persona.label ?? persona.id }}
                        </button>
                    </template>

                    <!-- The name sits alone on the row: accounts live in the open card, and the marks on the
                         right already say which platforms. A description slot would sit the title on the first
                         line of a two-line block and make it look top-heavy against the face.

                         A rename failure still uses this slot, because that is the one moment the row has
                         something to say under the name. The slot is omitted otherwise so Row does not reserve
                         a blank line for it. -->
                    <template v-if="rename.error !== undefined && renamingId === persona.id" #description>
                        <span class="text-danger">{{ rename.error }}</span>
                    </template>

                    <template #meta>
                        <!-- The sites this persona speaks on, as marks: two logos side by side say "spans
                             platforms" faster than any wording under them can. A notch under the face that
                             leads the row, because these are facts ABOUT the card, not the card itself.

                             16, not the tier's 22: #meta is a `text-2xs` cluster by <Row>'s contract, and a mark
                             drawn at the LEAD's size in it stops reading as a fact and starts competing with the
                             face for the row's subject. It was 22 while the face was 32 — the same one-notch
                             relationship, from when the face was a number this file chose. Same 16 <PersonaForm>
                             gives the account marks in its own lines. -->
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
                        <!-- A card that has been bounded says so on its row. Which shelf is off is the form's
                             business; what the LIST owes a reader scanning six cards is which of them are
                             limited at all: that is the difference between "my Front Desk is safe" being a
                             belief and being something they can see. -->
                        <StatusBadge v-if="persona.powers !== undefined" variant="neutral" size="xs">{{ personaBounds(persona) }}</StatusBadge>
                        <StatusBadge v-if="persona.capabilities.length > 0 && !ready(persona)" variant="neutral" size="xs" dot>
                            Not signed in
                        </StatusBadge>
                    </template>

                    <template #control>
                        <!-- A card that writes as you change it owes you a sign that it did. Only while the
                             write is in the air: a tick that lingers is a second thing to read on every row. -->
                        <Icon v-if="isOpen(persona) && save.isPending.value" name="spinner" spin class="text-2xs text-subtle" />
                        <button
                            type="button"
                            :class="ui.iconButton('hover:text-danger')"
                            aria-label="Remove this persona"
                            @click.stop="removing = persona"
                        >
                            <Icon name="trash" class="text-xs" />
                        </button>
                    </template>

                    <!-- The card opens INSIDE the row it belongs to, so there is never a form on screen whose
                         subject you have to remember, and the name it would have asked for first is the row's
                         own title, three lines up. No Save: an open card writes as it is changed.

                         It used to need a `click.stop` wrapper, because the row is the disclosure and every
                         switch flipped in here ALSO closed the card it belongs to. A `drawer` body is rendered
                         outside the row's click handler, so there is nothing left to stop. -->
                    <template #below>
                        <PersonaForm :draft="draft!" :accounts="accounts" :connected="connected" :grantables="grantables" :error="saveError" />
                    </template>
                </DisclosureRow>

                <!-- MAKING ONE ASKS FOR A NAME AND NOTHING ELSE, at the tail of the group where the new row will
                     appear. Everything else about a persona has a default worth keeping, and the card opens the
                     moment it exists, so this is the one field between "I want a persona" and having one, rather
                     than a form standing in front of thirty answers nobody has an opinion about yet. -->
                <RowNote v-if="newName !== undefined" v-slot="{ mark }" variant="block">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <!-- The face the row above it will have, at the size those rows draw it: this line
                                 becomes one of them the moment the name is committed. That promise is now kept by
                                 construction — `mark` is the tier's, the same number the rows above read. -->
                            <PersonaFace :persona="{ id: newId || `persona`, label: newName || undefined }" :size="mark" />
                            <!-- A name is three words. Capped, because an input stretched across the card reads
                                 as a field expecting a paragraph. Enter commits it, like any single-field form. -->
                            <input
                                v-model="newName"
                                :class="ui.input('min-w-0 max-w-xs flex-1 font-medium')"
                                placeholder="Name it: Work, Studio, Reddit Writer…"
                                aria-label="Name this persona"
                                autofocus
                                @keydown.enter="submit"
                            />
                            <Button label="Create" size="small" :loading="save.isPending.value" :disabled="!newValid" @click="submit" />
                            <button type="button" :class="ui.linkButton('text-xs text-muted hover:text-content')" @click="cancelAdd">Cancel</button>
                        </div>
                        <span v-if="nameHint !== undefined" class="text-xs text-warning">{{ nameHint }}</span>
                        <span v-else class="text-xs text-subtle">
                            It starts with the full toolbox, the whole workspace and the sandbox's own prompt. Change any of that once it opens.
                        </span>
                        <Notice v-if="saveError !== undefined" :of="saveError" />
                    </div>
                </RowNote>
            </RowGroup>
        </template>

        <!-- Removing a card takes away a persona, never an account: worth saying on the confirm, because the two
             are easy to conflate and only one of them is undoable by clicking again. -->
        <ConfirmDialog
            :open="removing !== undefined"
            :header="`Remove ${removing?.label ?? removing?.id}?`"
            confirm-label="Remove persona"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="removing = undefined"
            @confirm="confirmRemove"
        >
            The accounts it speaks through stay connected and signed in. Any automation pinned to this persona stops posting until you give it another
            one.
        </ConfirmDialog>
    </div>
</template>
