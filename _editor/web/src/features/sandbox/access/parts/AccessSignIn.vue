<script setup lang="ts">
import { Button, Notice, Row, RowGroup, RowNote, StatusBadge } from "@intentic/ui";
import { formatDate } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAuth } from "../../../../client/auth/useAuth";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { useRole } from "../../../../client/sandbox/useRole";
import { useSandboxSession } from "../../../../client/session/sandboxSession";
import { useOperation } from "../../../../workbench/operations/operations";
import PasskeysSection from "../PasskeysSection.vue";

// ACCESS ▸ SIGN-IN: how people prove themselves to this sandbox, and the browsers still holding a pass. Everyone manages
// their own passkeys here; signing every browser out is a maintainer's.

const t = useT();
const { user } = useAuth();
const { sessionExpiresAt } = useSandboxSession();
const { canShip } = useRole();

// No device roster can exist: a session is a signed claim the daemon verifies, not stored. The group says what's true:
// this browser, why the rest are unlistable, and the switch's consequence.
// The sign-out is the sandbox's: opened again mid-request, the tab holds the button and then says it was done.
const sessions = useOperation(`access/sessions/revoke`);
const revokingSessions = sessions.busy;
const sessionsRevoked = computed(() => sessions.operation.value?.state === `done`);
// Armed before firing: irreversible, signs out everyone, and can't be aimed at one device.
const confirmingRevoke = ref(false);
const armRevoke = (): void => {
    sessions.dismiss();
    confirmingRevoke.value = true;
};

// A date, not a countdown: the expiry slides forward on renewal, so it reads as neglect risk, not a deadline.
const thisBrowser = computed<string>(() => {
    const who = user.value?.email ?? t(`sandbox.sandboxAccess.youFallback`);
    const expires = sessionExpiresAt.value;
    return expires === undefined
        ? t(`sandbox.sandboxAccess.thisBrowserSignedIn`, { who })
        : t(`sandbox.sandboxAccess.thisBrowserSignedInUntil`, { who, date: formatDate(expires) });
});

const revokeSessions = async (): Promise<void> => {
    if (revokingSessions.value) {
        return;
    }
    const outcome = await sessions.run({
        what: t(`sandbox.sandboxAccess.signingOthersOut`),
        failed: t(`sandbox.sandboxAccess.couldntSignOthersOut`),
        // The line under the button says it, where the press was.
        quiet: true,
        task: async () => {
            await sandboxRaw(`POST /system/sessions/revoke`);
        },
    });
    if (outcome?.state === `done`) {
        confirmingRevoke.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <PasskeysSection />

        <!-- Credential revocation answers whether any access remains active. -->
        <RowGroup v-if="canShip" data-setting="access-signed-in-browsers" :label="t(`sandbox.sandboxAccess.signedInBrowsers`)">
            <!-- The one signed-in browser the app can name, because it is running in it. -->
            <Row icon="desktop" :title="t(`sandbox.sandboxAccess.browser`)" :description="thisBrowser">
                <template #meta><StatusBadge variant="success" :label="t(`sandbox.sandboxAccess.signedIn`)" size="xs" /></template>
            </Row>

            <Row icon="sign-out" tone="danger" :title="t(`sandbox.sandboxAccess.signOutEverywhere`)">
                <template #description>{{ t(`sandbox.sandboxAccess.revokesEveryPassStay`) }}</template>
                <template #control>
                    <!-- Clears the last run's receipt; the row says one thing at a time, not a stale result under a live confirm. -->
                    <Button
                        v-if="!confirmingRevoke"
                        :label="t(`sandbox.sandboxAccess.signOutAllBrowsers`)"
                        tone="danger"
                        size="small"
                        :disabled="revokingSessions"
                        @click="armRevoke"
                    >
                        <template #icon><Icon name="sign-out" /></template>
                    </Button>
                </template>
                <template v-if="confirmingRevoke || sessionsRevoked" #below>
                    <div v-if="confirmingRevoke" class="flex flex-wrap items-center justify-end gap-2">
                        <span class="mr-auto text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.sureEveryoneWorkingIn`) }}</span>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            tier="quiet"
                            size="small"
                            :disabled="revokingSessions"
                            @click="confirmingRevoke = false"
                        />
                        <Button
                            :label="t(`sandbox.sandboxAccess.signOutAllBrowsers`)"
                            tone="danger"
                            size="small"
                            :loading="revokingSessions"
                            @click="revokeSessions"
                        />
                    </div>
                    <p v-if="sessionsRevoked" class="flex items-center gap-1.5 text-xs font-semibold text-success">
                        <Icon name="check-circle" /> {{ t(`sandbox.sandboxAccess.everyBrowserSignedOut`) }}
                    </p>
                </template>
            </Row>
            <!-- A refusal is said under the press that made it, not over the People tab where it used to land. -->
            <RowNote v-if="sessions.failure.value" variant="block"><Notice :of="sessions.failure.value" /></RowNote>
        </RowGroup>
    </div>
</template>
