<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import { environment } from "../../app/environments/environment";
import { useAuth } from "../auth/useAuth";

// The setup page's way out of the account: who is signed in, and signing out. The page sits outside the shell, so the
// rail's account menu is not on it, and a reader signed in as the wrong Google account had no way off the page.

const props = defineProps<{
    // Runs while the session still stands: what the page does on leaving (deleting its draft row) needs the account.
    beforeSignOut: () => Promise<void>;
}>();

const t = useT();
const { user, signOut } = useAuth();
const failed = ref(false);

const leave = async (): Promise<void> => {
    failed.value = false;
    try {
        await props.beforeSignOut();
        await signOut();
    } catch (error) {
        console.warn(`setup: sign-out failed`, error);
        failed.value = true;
        return;
    }
    // Full navigation, not a router push: afterSignOut may point outside this SPA.
    globalThis.location.href = environment.afterSignOut;
};
</script>

<template>
    <div class="flex min-w-0 flex-col items-end">
        <!-- The masthead's quiet tier, at the size of "Back to workspace" beside it: an exit, not a step of the setup. -->
        <div class="flex min-w-0 items-center gap-1">
            <!-- The address answers "which account is this?", the usual reason to sign out here; a phone keeps only the action. -->
            <span v-if="user" class="hidden min-w-0 max-w-72 truncate text-[0.8125rem] text-muted sm:inline" :title="user.email">
                <span class="sr-only">{{ t(`setup.setupAccount.signedInAs`) }}</span>
                {{ user.email }}
            </span>
            <Button :label="t(`shell.words.signOut`)" severity="secondary" :text="true" class="shrink-0 text-[0.8125rem]" @click="leave">
                <template #icon><Icon name="sign-out" /></template>
            </Button>
        </div>
        <p v-if="failed" role="alert" class="text-2xs text-danger">{{ t(`setup.setupAccount.signOutFailed`) }}</p>
    </div>
</template>
