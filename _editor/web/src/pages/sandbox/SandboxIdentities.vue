<script setup lang="ts">
import type { Identity } from "@intentic/sandbox-contract";
import { cmp, ConfirmDialog, Row, RowGroup, StatusBadge } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import IdentityForm, { type IdentityDraft } from "./IdentityForm.vue";
import { useCapabilities } from "../../composables/extensions/useCapabilities";
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
const { capabilities } = useCapabilities();

// The accounts a card can name: the logged-in browser profiles. One capability = one account, so a site the
// owner connected twice appears twice and exactly one of them belongs on any given card.
const accounts = computed(() => capabilities.value.filter((capability) => capability.kind === `browser`));

const accountLabel = (id: string): string => {
    const platform = accounts.value.find((account) => account.id === id)?.config[`platform`];
    return typeof platform === `string` && platform !== id ? `${id} · ${platform}` : id;
};

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
        <p class="mb-4 max-w-2xl text-xs text-muted">
            A face is who this sandbox is when it acts outside — a name, the accounts it speaks through, and whether it may publish on its own. One
            face can hold accounts on several sites, because it stands for a person rather than a platform. The names are part of your workspace and
            travel with it; the logins stay in this sandbox.
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

            <RowGroup label="Your cast" :count="identities.length > 0 ? identities.length : undefined">
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

                <p v-if="identities.length === 0 && draft === undefined" class="px-4 pb-1 pt-2.5 text-xs text-subtle">
                    No faces yet. Until there is one, an automation you schedule can't post anywhere — and a chat reaches every account you've
                    connected.
                </p>

                <Row
                    v-for="identity in identities"
                    :key="identity.id"
                    :title="identity.label ?? identity.id"
                    :description="
                        identity.capabilities.length === 0
                            ? `No accounts — this face can't post anywhere`
                            : identity.capabilities.map(accountLabel).join(`, `)
                    "
                    density="compact"
                >
                    <template #meta>
                        <StatusBadge v-if="identity.posture === `draft`" variant="info" size="xs">Drafts only</StatusBadge>
                        <StatusBadge v-if="!ready(identity)" variant="neutral" size="xs" dot>Not signed in</StatusBadge>
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
                            class="pt-3"
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
                <div v-if="draft !== undefined && draft.original === undefined" class="px-4 py-3">
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

                <!-- The empty cast's own way in; once there are rows, the group header's button takes over. -->
                <div v-else-if="identities.length === 0" class="px-4 pb-2.5 pt-1">
                    <button type="button" class="flex items-center gap-2 text-xs text-muted transition-colors hover:text-content" @click="startAdd">
                        <Icon name="plus" class="text-2xs" /> Add a face
                    </button>
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
