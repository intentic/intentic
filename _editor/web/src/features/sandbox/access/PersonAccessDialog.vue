<script setup lang="ts">
import type { GrantedRole } from "@intentic/sandbox-contract";
import { Button, type IconName, Modal, Notice, type NoticeModel, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, useId, watch } from "vue";
import { useAreas } from "../areas/useAreas";
import { type AccessDraft, emailSignInByDefault, grantSendable, roleBounded, roleDrivesAgents, ROLE_ORDER } from "./accessGrant";
import AreaPicker from "./AreaPicker.vue";
import ReachPicker from "./ReachPicker.vue";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// ONE PERSON'S ACCESS, decided in one place and sent as one grant: who they are, the tier they hold, where they work
// (and with them every assistant working for them), and which connected accounts and secrets those assistants may
// spend. Adding and editing are the same form: editing opens on what the daemon holds for them, adding on the
// defaults a new teammate usually gets. Nothing is written until the commit press, so no half-made tier (a writer
// with no area, a guest reaching nobody) ever reaches the daemon.

const t = useT();

const open = defineModel<boolean>(`open`, { required: true });
const {
    editing,
    initial,
    busy = false,
    notice,
} = defineProps<{
    // The person being edited; absent while adding one.
    editing?: { readonly email: string; readonly pending: boolean } | undefined;
    // What the form opens on: the person's grant as the daemon holds it, or a new invite's defaults.
    initial: AccessDraft;
    busy?: boolean;
    // A refusal from the last commit, said inside the form rather than behind it.
    notice?: NoticeModel | undefined;
}>();
const emit = defineEmits<{ save: [email: string, draft: AccessDraft]; remove: [email: string]; resend: [email: string] }>();

const formId = useId();
const switchId = useId();

const email = ref(``);
const emailTouched = ref(false);
const draft = ref<AccessDraft>(initial);
// Whether the email-code switch was flipped by hand: until it is, it follows the address typed.
const signInPicked = ref(false);

// Each opening starts from what it was handed, never from the last person's leftovers.
watch(open, (now) => {
    if (now) {
        email.value = ``;
        emailTouched.value = false;
        signInPicked.value = editing !== undefined;
        draft.value = initial;
    }
});

const address = computed(() => (editing?.email ?? email.value).trim().toLowerCase());
const validEmail = computed(() => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address.value));
const emailError = computed(() => editing === undefined && emailTouched.value && email.value.trim().length > 0 && !validEmail.value);
watch(email, (typed) => {
    if (!signInPicked.value) {
        draft.value = { ...draft.value, emailSignIn: emailSignInByDefault(typed) };
    }
});

// The tiers as a reader climbs them, each with the sentence that says what it can do.
interface RoleChoice {
    readonly label: string;
    readonly hint: string;
    readonly icon: IconName;
}
const ROLES = computed(() => {
    const words = {
        guest: { label: t(`sandbox.sandboxAccess.guest`), hint: t(`sandbox.sandboxAccess.guestTalksToAssistants`), icon: `comments` },
        viewer: { label: t(`sandbox.sandboxAccess.viewer`), hint: t(`sandbox.sandboxAccess.watchEverythingAgentsChats`), icon: `eye` },
        // Files-through-agents is the clause people miss; collaborators land and publish only as requests.
        collaborator: { label: t(`sandbox.sandboxAccess.collaborator`), hint: t(`sandbox.sandboxAccess.driveAgentsReviewWork`), icon: `users` },
        writer: { label: t(`sandbox.sandboxAccess.writer`), hint: t(`sandbox.sandboxAccess.changeFilesInTheirFolders`), icon: `file-edit` },
        maintainer: { label: t(`sandbox.sandboxAccess.maintainer`), hint: t(`sandbox.sandboxAccess.operateEverythingOwnerOwner`), icon: `wrench` },
    } satisfies Record<GrantedRole, RoleChoice>;
    return ROLE_ORDER.map((value) => ({ value, ...words[value] }));
});

const { areas: sandboxAreas } = useAreas();
const { namesOf } = usePersonaReach();

const pickRole = (role: GrantedRole): void => {
    draft.value = { ...draft.value, role };
};

// Sendable as the daemon reads it, and one refusal of the form's own: a narrowed scope with nothing ticked is a fence
// admitting nothing, which nobody means by pressing "Only some areas".
const fenceReady = computed(() => {
    const { role, areas } = draft.value;
    if (!roleBounded(role)) {
        return true;
    }
    if (areas !== undefined && areas.length === 0 && sandboxAreas.value.length > 0) {
        return false;
    }
    return grantSendable(role, areas, namesOf(areas).length);
});
const canSave = computed(() => !busy && validEmail.value && fenceReady.value);

const save = (): void => {
    emailTouched.value = true;
    if (canSave.value) {
        emit(`save`, address.value, draft.value);
    }
};
</script>

<template>
    <Modal
        v-model:open="open"
        size="md"
        :header="editing === undefined ? t(`sandbox.sandboxAccess.addPersonTitle`) : editing.email"
        :description="editing === undefined ? t(`sandbox.sandboxAccess.addPersonDescription`) : t(`sandbox.sandboxAccess.editPersonDescription`)"
    >
        <form :id="formId" class="flex flex-col gap-7" @submit.prevent="save">
            <Notice v-if="notice" :of="notice" />

            <!-- WHO: the address the invite goes to, and whether a code mailed there also lets them in. -->
            <section class="flex flex-col gap-3">
                <label v-if="editing === undefined" class="ui-field">
                    <span class="ui-field-label">{{ t(`sandbox.sandboxAccess.emailLabel`) }}</span>
                    <input
                        v-model="email"
                        type="email"
                        autocomplete="off"
                        autofocus
                        placeholder="teammate@example.com"
                        :class="[ui.input(), emailError ? 'ui-field-error-box' : '']"
                        @blur="emailTouched = true"
                    />
                    <span v-if="emailError" class="ui-field-error">
                        <Icon name="exclamation-circle" class="text-2xs" />
                        {{ t(`sandbox.sandboxAccess.enterValidEmailAddress`) }}
                    </span>
                </label>
                <div class="flex items-start gap-3">
                    <ToggleSwitch
                        :input-id="switchId"
                        :model-value="draft.emailSignIn"
                        :disabled="busy"
                        class="ui-switch-sm mt-0.5 shrink-0"
                        @update:model-value="
                            (on: boolean) => {
                                signInPicked = true;
                                draft = { ...draft, emailSignIn: on };
                            }
                        "
                    />
                    <label :for="switchId" class="flex cursor-pointer flex-col gap-0.5">
                        <span class="text-sm text-content">{{ t(`sandbox.sandboxAccess.signInWithCode`) }}</span>
                        <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.signInWithCodeNote`) }}</span>
                    </label>
                </div>
            </section>

            <!-- WHAT THEY CAN DO: the tiers as rows with their sentence, since the sentence is what decides the pick. -->
            <section class="flex flex-col gap-2">
                <span :class="ui.sectionLabel()">{{ t(`sandbox.sandboxAccess.roleSection`) }}</span>
                <div role="radiogroup" :aria-label="t(`sandbox.sandboxAccess.roleSection`)" class="-mx-2.5 flex flex-col gap-0.5">
                    <button
                        v-for="role in ROLES"
                        :key="role.value"
                        type="button"
                        role="radio"
                        :aria-checked="draft.role === role.value"
                        :disabled="busy"
                        class="ui-row-select flex items-start gap-3 rounded-lg px-2.5 py-2 text-left"
                        :class="{ 'ui-row-select-on': draft.role === role.value }"
                        @click="pickRole(role.value)"
                    >
                        <Icon :name="role.icon" class="mt-0.5 shrink-0 text-muted" :class="{ 'text-primary-500': draft.role === role.value }" />
                        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span class="text-sm font-medium text-content">{{ role.label }}</span>
                            <span class="text-xs text-muted">{{ role.hint }}</span>
                        </span>
                        <Icon v-if="draft.role === role.value" name="check" class="mt-0.5 shrink-0 text-primary-500" />
                    </button>
                </div>
            </section>

            <!-- WHERE: their folders, which are also every assistant's folders when it works for them. -->
            <section class="flex flex-col gap-2">
                <div class="flex flex-col gap-1">
                    <span :class="ui.sectionLabel()">{{ t(`sandbox.sandboxAccess.whereSection`) }}</span>
                    <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.whereNote`) }}</span>
                </div>
                <p v-if="!roleBounded(draft.role)" class="text-sm text-muted">{{ t(`sandbox.sandboxAccess.maintainerUnfenced`) }}</p>
                <AreaPicker v-else :picked="draft.areas" :role="draft.role" :disabled="busy" @change="(areas) => (draft = { ...draft, areas })" />
            </section>

            <!-- WITH WHAT: the accounts and secrets their assistants may spend, held by the sandbox rather than asked of
                 the model. A viewer runs no assistant and a maintainer holds every credential, so neither is asked. -->
            <section class="flex flex-col gap-2">
                <div class="flex flex-col gap-1">
                    <span :class="ui.sectionLabel()">{{ t(`sandbox.sandboxAccess.reachSection`) }}</span>
                    <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.reachNote`) }}</span>
                </div>
                <p v-if="!roleBounded(draft.role)" class="text-sm text-muted">{{ t(`sandbox.sandboxAccess.reachMaintainer`) }}</p>
                <p v-else-if="!roleDrivesAgents(draft.role)" class="text-sm text-muted">{{ t(`sandbox.sandboxAccess.reachViewer`) }}</p>
                <ReachPicker v-else :reach="draft.credentials" :disabled="busy" @change="(credentials) => (draft = { ...draft, credentials })" />
            </section>
        </form>

        <template #footer>
            <!-- Taking access away and sending the invite again are about this person, not answers to the form: first, apart. -->
            <div v-if="editing !== undefined" class="mr-auto flex items-center gap-1">
                <Button :label="t(`sandbox.words.revokeAccess`)" tier="quiet" tone="danger" :disabled="busy" @click="emit(`remove`, editing.email)">
                    <template #icon><Icon name="trash" /></template>
                </Button>
                <Button v-if="editing.pending" :label="t(`sandbox.sandboxAccess.resend`)" tier="quiet" :disabled="busy" @click="emit(`resend`, editing.email)">
                    <template #icon><Icon name="send" /></template>
                </Button>
            </div>
            <Button :label="t(`ui.action.cancel`)" tier="quiet" :disabled="busy" @click="open = false" />
            <Button
                type="submit"
                :form="formId"
                :label="editing === undefined ? t(`sandbox.sandboxAccess.sendInvite`) : t(`ui.action.save`)"
                :loading="busy"
                :disabled="!canSave"
            >
                <template v-if="editing === undefined" #icon><Icon name="send" /></template>
            </Button>
        </template>
    </Modal>
</template>
