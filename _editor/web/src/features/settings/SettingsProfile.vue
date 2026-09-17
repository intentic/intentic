<script setup lang="ts">
import { Avatar, InlineRename, RowGroup, RowNote, StatusBadge } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { ref } from "vue";
import { fileToSquareDataUrl } from "../../lib/imageDataUrl";
import { useAuth } from "../auth/useAuth";
import { useHostedPlan } from "./hosted-plan/useHostedPlan";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Profile: display name + avatar, saved via Better Auth's update-user (useAuth.updateProfile). */

const { user, updateProfile } = useAuth();

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
        avatarError.value = `Couldn't read that file as an image.`;
        avatarBusy.value = false;
        return;
    }
    try {
        await updateProfile({ image: square });
    } catch (error) {
        avatarError.value = errorMessage(error, `Profile update failed.`);
    } finally {
        avatarBusy.value = false;
    }
};

const writeName = async (name: string): Promise<void> => {
    await updateProfile({ name });
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
</template>
