<script setup lang="ts">
import { type Persona, personaBounds } from "@intentic/sandbox-contract";
import { Avatar, BrandMark, cmp, ConfirmDialog, Notice, type NoticeModel, Row, RowGroup, SkeletonRows, StatusBadge } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import PersonaForm, { type PersonaDraft } from "./PersonaForm.vue";
import { createInlineRename } from "../../composables/inlineRename";
import { useBrowserAccounts } from "../../composables/extensions/useBrowserAccounts";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
import { identityHue } from "../../composables/identityHue";
import { FULL_POWERS, grantablesFrom, type PersonaGrantable, personaSlug, powersDraftOf, storedPowers } from "../../composables/sandbox/personaCard";
import { usePersonas } from "../../composables/sandbox/usePersonas";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";

/* THE PERSONAS this sandbox wears when it acts outside, and the one place a WHOLE card is written — the accounts
 * it speaks through, what it may do, where it works. (A folder's own personas can also be named and bounded from
 * the Workspace tree's row icon; that panel asks for a name and links here for the rest. Both write through
 * personaCard.ts.)
 *
 * A persona is NOT per-site. It is a person the outside world reads: "Work" holds its Reddit account AND its X
 * account AND whatever else belongs to that person, so one card can span every platform the owner signed into
 * under that name. That is the whole reason the layer exists — the accounts already live one-per-login in the
 * capability manifest, and what was missing was anything saying which of them are the same someone.
 *
 * It lives in the sandbox hub rather than beside the accounts on /capabilities because it is a property of the
 * BOX, shared by every chat and every automation in it, not a detail of one connection. The accounts page
 * answers "what is this sandbox signed into"; this answers "who is it".
 *
 * Under "Reach" and pointedly not under "Configuration", where the AI-account row lives: those two are one
 * letter apart in English and opposite in consequence — which subscription PAYS for a turn versus whose name is
 * on what it posts — and putting them in the same group is how someone eventually gets the billing right and
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

// The other three things a card grants by id — see grantablesFrom, shared with the Workspace tree's quick panel.
const { capabilities } = useCapabilities();
const grantables = computed<PersonaGrantable[]>(() => grantablesFrom(capabilities.value));

/* The marks a row shows for the accounts its card names — the fastest way to read that a persona spans two
 * sites, and the reason the row does not spell them out in a comma-joined line. An id the manifest has no
 * capability for still gets an entry: a card may name an account nobody has added HERE, and dropping it would
 * make the row claim a persona reaches less than it was written to. */
const marks = (persona: Persona) => persona.capabilities.map((id) => ({ id, account: accountOf(id), signedIn: isConnected(id) }));

/* Whether a card can act AT ALL right now. A persona naming three accounts with one signed in is still usable —
 * the turn simply reaches the one — so this marks only the persona that can reach nothing, which is every one
 * of them on a workspace someone has just cloned and the state a surface must not paint as working. */
const ready = (persona: Persona): boolean => persona.capabilities.some((id) => isConnected(id));

/* ── The editor ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * AN ACCORDION OVER A SETTINGS OBJECT, and the two rules that follow from calling it that.
 *
 * A persona is settings, not a document: nine switches, two folder answers and a list of accounts, each of which
 * means something on its own. So an OPEN card writes as you change it — flip a switch and it is flipped, the way
 * every settings surface people already use behaves — and there is no Save button to leave a card half-decided
 * behind. A NEW card is the exception and keeps its explicit Create, because there is nothing to write to until
 * it has a name, and because "added a persona" should be something somebody did on purpose.
 *
 * The row is the disclosure. There is no pencil-to-edit mode: the thing you click to see a card is the thing you
 * click to change it, which is one affordance instead of two and the pattern the Environment tab already uses.
 * The NAME is not in the panel at all — it stays the row's own title, text until you click it (inlineRename). */
const draft = ref<PersonaDraft | undefined>(undefined);
const saveError = ref<NoticeModel | undefined>(undefined);

const NO_SCOPE = { startIn: [], folders: [] };
const draftOf = (persona: Persona): PersonaDraft => ({
    original: persona.id,
    label: persona.label ?? persona.id,
    capabilities: [...persona.capabilities],
    ...powersDraftOf(persona),
    // One folder or none, carried as a list because that is what the picker models either way.
    startIn: persona.workspace?.startIn === undefined ? [] : [persona.workspace.startIn],
    folders: [...(persona.workspace?.folders ?? [])],
});

/* Changing the draft without the autosave below reading it as an edit — installing one on open, and writing a
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

const startAdd = (): void => {
    saveError.value = undefined;
    quietly(() => {
        draft.value = { original: undefined, label: ``, capabilities: [], ...FULL_POWERS, ...NO_SCOPE };
    });
};
const cancelAdd = (): void => {
    draft.value = undefined;
    saveError.value = undefined;
};

const draftId = computed(() => draft.value?.original ?? personaSlug(draft.value?.label ?? ``));
// A new card may not land on a name already taken — saving would silently edit the other one instead.
const taken = computed(() => draft.value?.original === undefined && personas.value.some((persona) => persona.id === draftId.value));
const draftValid = computed(() => draftId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (draft.value === undefined || draft.value.label === `` || draftValid.value) {
        return undefined;
    }
    return taken.value ? `You already have a persona called ${draftId.value}.` : `Use letters or digits.`;
});

/* WHAT IS WORTH STORING. A card that grants everything stores no `powers` at all, and one that limits nothing
 * stores no `workspace` — so the committed file stays a description of the DECISIONS somebody made rather than a
 * dump of every default, and a diff on it reads as the change it was.
 *
 * That is the same rule the label follows, applied to two objects instead of a field. The powers half lives in
 * personaCard.ts, because the tree's quick panel writes cards too and two copies of this rule is two answers to
 * "was anything actually decided here". */
const cardFrom = (state: PersonaDraft, id: string): Persona => {
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
    };
};

// The explicit half: creating a card, which closes the form on success.
const submit = async (): Promise<void> => {
    if (draft.value === undefined || !draftValid.value) {
        return;
    }
    saveError.value = undefined;
    try {
        await save.mutateAsync(cardFrom(draft.value, draftId.value));
        draft.value = undefined;
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
    if (state?.original === undefined) {
        return;
    }
    saveError.value = undefined;
    try {
        await save.mutateAsync(cardFrom(state, state.original));
    } catch (err) {
        saveError.value = noticeFrom(err, `Could not save this persona.`);
    }
};
watch(
    draft,
    () => {
        if (settling || draft.value?.original === undefined) {
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
 * A rename writes the WHOLE card, because the save is an upsert — and it reads that card from the open draft
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
        await save.mutateAsync(open !== undefined ? { ...cardFrom(open, id), label: name } : { ...renameTarget.value!, label: name });
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
        <!-- One sentence. The rest of what a persona is — that it spans sites, that the names travel and the
             logins don't — is shown by the surface itself rather than explained above it. -->
        <p class="mb-5 max-w-2xl text-sm text-muted">
            A persona is who this sandbox is when it works: the accounts it speaks through, what it may do, and where in the workspace it works. Point
            an automation at one and it runs inside those bounds.
        </p>

        <Notice v-if="listNotice" :of="listNotice" class="mb-4" />
        <!-- The empty state below is a real one — it explains what NOT having a persona costs — so it must not
             be shown to somebody who simply has not been told yet. The list's own shape stands in meanwhile. -->
        <template v-if="isLoading">
            <RowGroup v-if="outline" label="Your personas">
                <div role="status" aria-busy="true">
                    <span class="sr-only">Reading your sandbox's personas…</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>
        </template>

        <template v-else>
            <!-- Nothing to name a persona after yet. Said once, up front, because every card below would
                 otherwise be built out of accounts that do not exist. -->
            <RouterLink
                v-if="accounts.length === 0"
                to="/capabilities"
                :class="cmp.alertWarning('mb-4 flex items-center gap-2 no-underline transition-colors hover:border-warning')"
            >
                <Icon name="exclamation-triangle" class="shrink-0" />
                <span>No accounts connected yet — a persona needs at least one to speak through.</span>
                <span class="ml-auto inline-flex items-center gap-1 font-medium">Connect <Icon name="arrow-right" class="text-2xs" /></span>
            </RouterLink>

            <!-- NO PERSONAS AND NOTHING BEING WRITTEN gets a real empty state rather than a group with one line
                 of apology in it. It says what is true right now — automations are mute, chats are unrestricted
                 — because that is the consequence someone is here to change, and offers the one action. -->
            <div v-if="personas.length === 0 && draft === undefined" :class="cmp.emptyState('flex flex-col items-center gap-3 py-8')">
                <Avatar :size="40" />
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium text-content">No personas yet</span>
                    <span class="max-w-md text-xs text-muted">
                        Until there is one, an automation you schedule can't post anywhere — and a chat reaches every account you've connected.
                    </span>
                </div>
                <Button label="Add a persona" size="small" :disabled="accounts.length === 0" @click="startAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <RowGroup v-else label="Your personas" :count="personas.length > 0 ? personas.length : undefined">
                <template #actions>
                    <Button
                        v-if="personas.length > 0 && draft === undefined"
                        label="Add a persona"
                        size="small"
                        severity="secondary"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <!-- THE ROW IS THE DISCLOSURE. Clicking it opens the card in place; there is no second
                     affordance meaning the same thing, which is what the pencil used to be. -->
                <Row
                    v-for="persona in personas"
                    :key="persona.id"
                    :title="persona.label ?? persona.id"
                    density="comfortable"
                    interactive
                    @click="toggleOpen(persona)"
                >
                    <!-- A persona is a person, so it gets a person's mark and keeps the same colour on every
                         surface it appears on. Keyed by the id, not the label, so renaming does not recolour
                         somebody you have learned to recognise. The disclosure arrow rides in front of it —
                         where a reader looks for one — rather than in the row's trailing cluster, which is
                         where facts and actions live. -->
                    <template #lead>
                        <span class="flex items-center gap-1.5">
                            <Icon
                                :name="isOpen(persona) ? `chevron-down` : `chevron-right`"
                                class="w-3 shrink-0 text-2xs text-subtle transition-colors"
                            />
                            <Avatar :size="32" :name="persona.label ?? persona.id" :hue="identityHue(persona.id)" :idle="!ready(persona)" />
                        </span>
                    </template>

                    <!-- THE NAME READS AS A NAME until you ask to change it — click-to-rename, on the app's one
                         inline-rename machine (enter commits, escape cancels, blur commits, unchanged is a
                         silent cancel). An input parked here permanently would make a settings list look like a
                         form and put a text box where every other row in the app has a title. -->
                    <template #title>
                        <input
                            v-if="rename.editing && renamingId === persona.id"
                            v-model="rename.draft"
                            :class="cmp.input('w-full max-w-xs py-0.5 font-medium')"
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

                    <!-- THE ACCOUNTS BY NAME, under the persona's own. The marks on the right say which
                         platforms at a glance, but a mark cannot tell `reddit-work` from `reddit-personal` — those
                         two being different is the entire problem this feature exists to solve, so the names
                         are not something the row can leave to a tooltip. -->
                    <template #description>
                        <span v-if="rename.error !== undefined && renamingId === persona.id" class="text-danger">{{ rename.error }}</span>
                        <span v-else-if="persona.capabilities.length === 0" class="text-warning">
                            No accounts — this persona can't post anywhere
                        </span>
                        <!-- Separated, because two account names running together read as one. A signed-out
                             account is dimmed rather than struck through: a line through it says REMOVED, and
                             what is true is that it is listed and cannot act yet — which the badge names. -->
                        <span v-else class="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                            <template v-for="(mark, at) in marks(persona)" :key="mark.id">
                                <span v-if="at > 0" class="text-subtle">·</span>
                                <span :class="mark.signedIn ? `` : `text-subtle`" :title="mark.signedIn ? undefined : `Not signed in yet`">
                                    {{ mark.id }}
                                </span>
                            </template>
                        </span>
                    </template>

                    <template #meta>
                        <!-- The sites this persona speaks on, as marks: two logos side by side say "spans
                             platforms" faster than any wording under them can. -->
                        <span v-if="persona.capabilities.length > 0" class="flex items-center gap-1">
                            <BrandMark
                                v-for="mark in marks(persona)"
                                :key="mark.id"
                                :size="20"
                                :name="mark.account?.site ?? mark.id"
                                :logo="mark.account?.logo"
                                :icon="mark.account?.icon ?? `globe`"
                                :idle="!mark.signedIn"
                            />
                        </span>
                        <!-- A card that has been bounded says so on its row. Which shelf is off is the form's
                             business; what the LIST owes a reader scanning six cards is which of them are
                             limited at all — that is the difference between "my Doorbell is safe" being a
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
                            :class="cmp.iconButton('hover:text-danger')"
                            aria-label="Remove this persona"
                            @click.stop="removing = persona"
                        >
                            <Icon name="trash" class="text-xs" />
                        </button>
                    </template>

                    <!-- The card opens INSIDE the row it belongs to, so there is never a form on screen whose
                         subject you have to remember — and the name it would have asked for first is the row's
                         own title, three lines up. No Save: an open card writes as it is changed.

                         `click.stop` because the row itself is the disclosure — without it every switch flipped
                         in here would ALSO close the card it belongs to. -->
                    <template v-if="isOpen(persona)" #below>
                        <div class="pt-4" @click.stop>
                            <PersonaForm
                                :draft="draft!"
                                :accounts="accounts"
                                :connected="connected"
                                :grantables="grantables"
                                :valid="draftValid"
                                :saving="save.isPending.value"
                                :error="saveError"
                                :show-name="false"
                            />
                        </div>
                    </template>
                </Row>

                <!-- A NEW card has no row to open inside, so it gets one of its own at the tail of the group —
                     and it is the one card with an explicit action, because there is nothing to write to until
                     it has a name. -->
                <div v-if="draft !== undefined && draft.original === undefined" class="px-4 py-4">
                    <PersonaForm
                        :draft="draft"
                        :accounts="accounts"
                        :connected="connected"
                        :grantables="grantables"
                        :valid="draftValid"
                        :saving="save.isPending.value"
                        :error="saveError"
                        :name-hint="nameHint"
                        submit-label="Add persona"
                        @submit="submit"
                        @cancel="cancelAdd"
                    />
                </div>
            </RowGroup>
        </template>

        <!-- Removing a card takes away a persona, never an account — worth saying on the confirm, because the two
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
