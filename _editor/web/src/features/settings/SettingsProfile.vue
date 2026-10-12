<script setup lang="ts">
import { Avatar, Button, InlineRename, Row, RowGroup, RowNote, StatusBadge } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { fileToSquareDataUrl } from "../../lib/imageDataUrl";
import { useAccount } from "../../client/auth/useAccount";
import { signsInByEmail, signsInWithGoogle } from "../../client/auth/signInMethods";
import { useHostedPlan } from "./hosted-plan/useHostedPlan";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Profile: display name + avatar, saved via Better Auth's update-user (useAccount.updateProfile: the workspace's own
   session, or in a desktop window on a folder the one the app reaches for it). */

const { user, updateProfile, local } = useAccount();

/* The plan chip beside the name: the same derivation the account menu reads, so the two cannot disagree about which lane this account is on. */
const { planBadge } = useHostedPlan();

const avatarInput = ref<HTMLInputElement | null>(null);
const avatarBusy = ref(false);
// The avatar's own report, and the only thing that can put a line under this name: the rename carries its state
// inside its own box, so entering and leaving edit mode never moves the row.
const avatarError = ref<string | undefined>(undefined);

const pickAvatar = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    if (file === undefined) {
        return;
    }
    avatarError.value = undefined;
    avatarBusy.value = true;
    let square: string;
    try {
        square = await fileToSquareDataUrl(file, `cover`);
    } catch {
        avatarError.value = t(`settings.settingsProfile.notAnImage`);
        avatarBusy.value = false;
        return;
    }
    try {
        await updateProfile({ image: square });
    } catch (error) {
        avatarError.value = messageOr(error, t(`settings.settingsProfile.updateFailed`));
    } finally {
        avatarBusy.value = false;
    }
};

const writeName = async (name: string): Promise<void> => {
    await updateProfile({ name });
};

/* How this account signs in, for one that signs in by email code: whether Google is linked beside it, and the press that
   links it (the free hosted machine and the trial need it). A desktop window on a folder runs as a placeholder for the
   account and cannot link anything; the workspace's own settings can. */
const methods = computed(() => user.value?.signInMethods);
const showsSignIn = computed(() => local !== true && signsInByEmail(methods.value));
const googleLinked = computed(() => signsInWithGoogle(methods.value));
const linking = ref(false);
const linkError = ref<string | undefined>(undefined);
const linkGoogle = async (): Promise<void> => {
    linking.value = true;
    linkError.value = undefined;
    try {
        // Loaded at the press: the settings view needs nothing else of the platform's sign-in client.
        const { useAuth } = await import(`../../client/auth/useAuth`);
        // Google's page, then back here with the account holding both ways in.
        await useAuth().linkGoogle(`/settings`);
    } catch (error) {
        linkError.value = messageOr(error, t(`auth.useAuth.linkGoogleFailed`));
        linking.value = false;
    }
};
</script>

<template>
    <RowGroup :label="t(`settings.settingsProfile.profile`)">
        <RowNote variant="block">
            <div class="flex min-w-0 items-center gap-3">
                <button
                    type="button"
                    :disabled="avatarBusy"
                    :aria-label="t(`settings.settingsProfile.changeAvatar`)"
                    v-tooltip.bottom="t(`settings.settingsProfile.changeAvatar`)"
                    class="group relative h-14 w-14 shrink-0 cursor-pointer rounded-full"
                    @click="avatarInput?.click()"
                >
                    <Avatar :size="56" :src="user?.image" :name="user?.name" />
                    <span
                        class="absolute inset-0 flex items-center justify-center rounded-full bg-canvas/70 text-content transition-opacity"
                        :class="avatarBusy ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'"
                    >
                        <Icon :name="avatarBusy ? `spinner` : `camera`" :spin="avatarBusy" class="text-base" />
                    </span>
                </button>
                <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="pickAvatar" />

                <div class="min-w-0 flex-1">
                    <div class="flex min-w-0 items-center gap-2">
                        <!-- The name is the field: one box for both states, so the plan chip beside it never moves. -->
                        <h2 class="flex min-w-0 text-base font-medium">
                            <InlineRename
                                :value="user?.name"
                                :write="writeName"
                                :label="t(`settings.settingsProfile.displayName`)"
                                :action="t(`settings.settingsProfile.renameDisplayName`)"
                                fallback="Account"
                                :maxlength="60"
                                failure="Couldn't save your display name."
                            />
                        </h2>

                        <!-- THE LANE THIS ACCOUNT IS ON, the same chip the account menu wears (hostedHours.ts). -->
                        <StatusBadge
                            v-if="planBadge"
                            :variant="planBadge.variant"
                            :label="planBadge.label"
                            class="shrink-0"
                            v-tooltip.bottom="planBadge.detail"
                        />
                    </div>
                    <p v-if="avatarError" class="h-4 truncate px-1 text-xs leading-4 text-danger">{{ avatarError }}</p>
                </div>
            </div>
        </RowNote>
    </RowGroup>

    <RowGroup v-if="showsSignIn" :label="t(`settings.settingsProfile.signIn`)">
        <Row icon="envelope" :title="t(`settings.settingsProfile.emailCode`)" :description="t(`settings.settingsProfile.emailCodeDetail`, { email: user?.email ?? `` })" />
        <Row
            icon="google"
            :title="t(`settings.settingsProfile.google`)"
            :description="googleLinked ? t(`settings.settingsProfile.googleLinked`) : t(`settings.settingsProfile.googleNotLinked`)"
        >
            <template v-if="!googleLinked" #control>
                <Button :label="t(`settings.settingsProfile.linkGoogle`)" size="small" tier="boring" :loading="linking" @click="linkGoogle">
                    <template #icon><Icon name="google" /></template>
                </Button>
            </template>
        </Row>
        <RowNote v-if="linkError" variant="block">
            <p class="text-xs text-danger">{{ linkError }}</p>
        </RowNote>
    </RowGroup>
</template>
