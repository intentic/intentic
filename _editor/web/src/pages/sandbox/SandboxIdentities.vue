<script setup lang="ts">
import type { Identity } from "@intentic/sandbox-contract";
import { Avatar, BrandMark, cmp, ConfirmDialog, Row, RowGroup, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import IdentityForm, { type IdentityDraft } from "./IdentityForm.vue";
import { useBrowserAccounts } from "../../composables/extensions/useBrowserAccounts";
import { identityHue } from "../../composables/identityHue";
import { useIdentities } from "../../composables/sandbox/useIdentities";
import { errorMessage } from "../../composables/useAsyncAction";

/* THE CAST — the faces this sandbox wears when it acts outside, and the one place they are created and edited.
 *
 * A face is NOT per-site. It is a person the outside world reads: "Work" holds its Reddit account AND its X
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

const { identities, connected, isConnected, error, isLoading, save, remove } = useIdentities();
// The accounts a card can name: the logged-in browser profiles, each carrying the brand of the site it is an
// account of. One capability = one account, so a site the owner connected twice appears twice and exactly one
// of them belongs on any given card.
const { accounts, accountOf } = useBrowserAccounts();

/* The marks a row shows for the accounts its card names — the fastest way to read that a face spans two sites,
 * and the reason the row does not spell them out in a comma-joined line. An id the manifest has no capability
 * for still gets an entry: a card may name an account nobody has added HERE, and dropping it would make the
 * row claim a face reaches less than it was written to. */
const marks = (identity: Identity) => identity.capabilities.map((id) => ({ id, account: accountOf(id), signedIn: isConnected(id) }));

/* Whether a card can act AT ALL right now. A face naming three accounts with one signed in is still usable —
 * the turn simply reaches the one — so this marks only the face that can reach nothing, which is every face on
 * a workspace someone has just cloned and the state a surface must not paint as working. */
const ready = (identity: Identity): boolean => identity.capabilities.some((id) => isConnected(id));

// ── The editor ──────────────────────────────────────────────────────────────────────────────────────────────
// One draft at a time, opened either by "Add a face" (`original` undefined) or by a row's pencil.
const draft = ref<IdentityDraft | undefined>(undefined);
const saveError = ref<string | undefined>(undefined);

/* The id comes from the name so nobody types one, and once a card exists it is FROZEN: automations pin to the
 * id, and a rename that silently re-keyed the card would unpin them without saying so. Renaming the label is
 * therefore free, and the id it was created under is what it keeps. */
const slug = (name: string): string =>
    name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .slice(0, 60);

const startAdd = (): void => {
    saveError.value = undefined;
    draft.value = { original: undefined, label: ``, capabilities: [], voice: ``, posture: `publish` };
};
const startEdit = (identity: Identity): void => {
    saveError.value = undefined;
    draft.value = {
        original: identity.id,
        label: identity.label ?? identity.id,
        capabilities: [...identity.capabilities],
        voice: identity.voice ?? ``,
        posture: identity.posture ?? `publish`,
    };
};
const cancelEdit = (): void => {
    draft.value = undefined;
    saveError.value = undefined;
};

const draftId = computed(() => draft.value?.original ?? slug(draft.value?.label ?? ``));
// A new card may not land on a name already taken — saving would silently edit the other one instead.
const taken = computed(() => draft.value?.original === undefined && identities.value.some((identity) => identity.id === draftId.value));
const draftValid = computed(() => draftId.value !== `` && !taken.value);
const nameHint = computed(() => {
    if (draft.value === undefined || draft.value.label === `` || draftValid.value) {
        return undefined;
    }
    return taken.value ? `You already have a face called ${draftId.value}.` : `Use letters or digits.`;
});

const submit = async (): Promise<void> => {
    if (draft.value === undefined || !draftValid.value) {
        return;
    }
    const { label, capabilities: picked, voice, posture } = draft.value;
    saveError.value = undefined;
    try {
        await save.mutateAsync({
            id: draftId.value,
            // Only worth storing when it says something the id does not.
            ...(label.trim() !== `` && label.trim() !== draftId.value ? { label: label.trim() } : {}),
            capabilities: picked,
            ...(voice.trim() !== `` ? { voice: voice.trim() } : {}),
            // "publish" is what every account does today, so only the restrictive posture is worth recording.
            ...(posture === `draft` ? { posture: `draft` as const } : {}),
        });
        draft.value = undefined;
    } catch (err) {
        saveError.value = errorMessage(err, `Could not save this face.`);
    }
};

// ── Removal ─────────────────────────────────────────────────────────────────────────────────────────────────
const removing = ref<Identity | undefined>(undefined);
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
        <!-- One sentence. The rest of what a face is — that it spans sites, that the names travel and the
             logins don't — is shown by the surface itself rather than explained above it. -->
        <p class="mb-5 max-w-2xl text-sm text-muted">
            A face is who this sandbox is when it acts outside: a name, the accounts it speaks through, and whether it may publish on its own.
        </p>

        <div v-if="error" :class="cmp.alertDanger('mb-4')">{{ error }}</div>
        <div v-if="isLoading" :class="cmp.emptyState('py-6')"><Icon name="spinner" spin /> Reading your sandbox's faces…</div>

        <template v-else>
            <!-- Nothing to name a face after yet. Said once, up front, because every card below would otherwise
                 be built out of accounts that do not exist. -->
            <RouterLink
                v-if="accounts.length === 0"
                to="/capabilities"
                :class="cmp.alertWarning('mb-4 flex items-center gap-2 no-underline transition-colors hover:border-warning')"
            >
                <Icon name="exclamation-triangle" class="shrink-0" />
                <span>No accounts connected yet — a face needs at least one to speak through.</span>
                <span class="ml-auto inline-flex items-center gap-1 font-medium">Connect <Icon name="arrow-right" class="text-2xs" /></span>
            </RouterLink>

            <!-- NO CAST AND NOTHING BEING WRITTEN gets a real empty state rather than a group with one line of
                 apology in it. It says what is true right now — automations are mute, chats are unrestricted —
                 because that is the consequence someone is here to change, and offers the one action. -->
            <div v-if="identities.length === 0 && draft === undefined" :class="cmp.emptyState('flex flex-col items-center gap-3 py-8')">
                <Avatar :size="40" />
                <div class="flex flex-col gap-1">
                    <span class="text-sm font-medium text-content">No faces yet</span>
                    <span class="max-w-md text-xs text-muted">
                        Until there is one, an automation you schedule can't post anywhere — and a chat reaches every account you've connected.
                    </span>
                </div>
                <Button label="Add a face" size="small" :disabled="accounts.length === 0" @click="startAdd">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </div>

            <RowGroup v-else label="Your cast" :count="identities.length > 0 ? identities.length : undefined">
                <template #actions>
                    <Button
                        v-if="identities.length > 0 && draft === undefined"
                        label="Add a face"
                        size="small"
                        severity="secondary"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>

                <Row v-for="identity in identities" :key="identity.id" :title="identity.label ?? identity.id" density="comfortable">
                    <!-- A face is a person, so it gets a person's mark and keeps the same colour on every
                         surface it appears on. Keyed by the id, not the label, so renaming does not recolour
                         somebody you have learned to recognise. -->
                    <template #lead>
                        <Avatar :size="32" :name="identity.label ?? identity.id" :hue="identityHue(identity.id)" :idle="!ready(identity)" />
                    </template>

                    <!-- THE ACCOUNTS BY NAME, under the face's own. The marks on the right say which platforms
                         at a glance, but a mark cannot tell `reddit-work` from `reddit-personal` — and those
                         two being different is the entire problem this feature exists to solve, so the names
                         are not something the row can leave to a tooltip. -->
                    <template #description>
                        <span v-if="identity.capabilities.length === 0" class="text-warning">No accounts — this face can't post anywhere</span>
                        <!-- Separated, because two account names running together read as one. A signed-out
                             account is dimmed rather than struck through: a line through it says REMOVED, and
                             what is true is that it is listed and cannot act yet — which the badge names. -->
                        <span v-else class="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                            <template v-for="(mark, at) in marks(identity)" :key="mark.id">
                                <span v-if="at > 0" class="text-subtle">·</span>
                                <span :class="mark.signedIn ? `` : `text-subtle`" :title="mark.signedIn ? undefined : `Not signed in yet`">
                                    {{ mark.id }}
                                </span>
                            </template>
                        </span>
                    </template>

                    <template #meta>
                        <!-- The sites this face speaks on, as marks: two logos side by side say "spans
                             platforms" faster than any wording under them can. -->
                        <span v-if="identity.capabilities.length > 0" class="flex items-center gap-1">
                            <BrandMark
                                v-for="mark in marks(identity)"
                                :key="mark.id"
                                :size="20"
                                :name="mark.account?.site ?? mark.id"
                                :logo="mark.account?.logo"
                                :icon="mark.account?.icon ?? `globe`"
                                :idle="!mark.signedIn"
                            />
                        </span>
                        <StatusBadge v-if="identity.posture === `draft`" variant="info" size="xs">Drafts only</StatusBadge>
                        <StatusBadge v-if="identity.capabilities.length > 0 && !ready(identity)" variant="neutral" size="xs" dot>
                            Not signed in
                        </StatusBadge>
                    </template>

                    <template #control>
                        <button type="button" :class="cmp.iconButton()" aria-label="Edit this face" @click="startEdit(identity)">
                            <Icon name="pencil" class="text-xs" />
                        </button>
                        <button type="button" :class="cmp.iconButton('hover:text-danger')" aria-label="Remove this face" @click="removing = identity">
                            <Icon name="trash" class="text-xs" />
                        </button>
                    </template>

                    <!-- The editor opens INSIDE the row it belongs to, so there is never a form on screen whose
                         subject you have to remember. -->
                    <template v-if="draft !== undefined && draft.original === identity.id" #below>
                        <IdentityForm
                            class="pt-4"
                            :draft="draft"
                            :accounts="accounts"
                            :connected="connected"
                            :valid="draftValid"
                            :saving="save.isPending.value"
                            :error="saveError"
                            :name-hint="nameHint"
                            submit-label="Save"
                            @submit="submit"
                            @cancel="cancelEdit"
                        />
                    </template>
                </Row>

                <!-- A new card has no row to open inside, so it gets one of its own at the tail of the group. -->
                <div v-if="draft !== undefined && draft.original === undefined" class="px-4 py-4">
                    <IdentityForm
                        :draft="draft"
                        :accounts="accounts"
                        :connected="connected"
                        :valid="draftValid"
                        :saving="save.isPending.value"
                        :error="saveError"
                        :name-hint="nameHint"
                        submit-label="Add face"
                        @submit="submit"
                        @cancel="cancelEdit"
                    />
                </div>
            </RowGroup>
        </template>

        <!-- Removing a card takes away a face, never an account — worth saying on the confirm, because the two
             are easy to conflate and only one of them is undoable by clicking again. -->
        <ConfirmDialog
            :open="removing !== undefined"
            :header="`Remove ${removing?.label ?? removing?.id}?`"
            confirm-label="Remove face"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="removing = undefined"
            @confirm="confirmRemove"
        >
            The accounts it speaks through stay connected and signed in. Any automation pinned to this face stops posting until you give it another
            one.
        </ConfirmDialog>
    </div>
</template>
