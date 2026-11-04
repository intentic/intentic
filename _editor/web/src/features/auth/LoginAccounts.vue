<!-- The sign-in screen's other accounts (loginAccounts.ts): the ones still signed in on this browser, each one press from
     being active again, when nobody's session is. Rows on the screen's own frame, face and address, nothing more. -->
<script setup lang="ts">
import { Avatar, Notice, SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { DeviceSession } from "../../client/auth/useAuth";

defineProps<{
    readonly accounts: readonly DeviceSession[];
    readonly failure?: string | undefined;
}>();
const emit = defineEmits<{ continue: [account: DeviceSession] }>();
const t = useT();
</script>

<template>
    <section v-if="accounts.length > 0 || failure" class="flex flex-col gap-1" :aria-label="t(`auth.accounts.stillSignedIn`)" data-test="continue-as">
        <SectionHeader :label="t(`auth.accounts.stillSignedIn`)" density="dense" />
        <button
            v-for="account in accounts"
            :key="account.token"
            type="button"
            class="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm text-content transition-colors hover:bg-content/5"
            data-test="continue-as-row"
            @click="emit(`continue`, account)"
        >
            <Avatar :size="24" :src="account.user.image" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ t(`auth.accounts.continueAs`, { email: account.user.email }) }}</span>
            <Icon name="arrow-right" class="shrink-0 text-xs text-subtle" />
        </button>
        <Notice v-if="failure" tone="danger" class="text-2xs">{{ failure }}</Notice>
    </section>
</template>
