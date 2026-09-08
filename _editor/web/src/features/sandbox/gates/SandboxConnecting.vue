<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSession } from "../client/sandboxSession";
import { useSandbox } from "../client/useSandbox";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { connectionNotice } from "./connectionNotice";

// Shown whenever the active sandbox's daemon isn't reachable. What it says is a pure function of the classified
// failure (connectionNotice), so setup, sign-in and account-mismatch causes each get their own words and action.
// Flips to the real views the moment the daemon answers.

const { active, connection, activeWakeRefused } = useSandbox();
const { clearCredential } = useGoogleIdentity();
const { invalidateSession, getSessionToken } = useSandboxSession();

// Runs only while an outage is ongoing; a connected workspace pays nothing for the clock.
const timing = computed(() => connection.value.unavailableSince !== undefined);
const now = useNow(timing);
const notice = computed(() =>
    connectionNotice({
        failure: connection.value.failure,
        sandboxName: active.value?.name,
        // A machine the platform started for this sandbox, which earns the gate the right to name a cause.
        hostedMachine: (active.value?.hosted ?? null) !== null,
        outageMs: connection.value.unavailableSince === undefined ? 0 : now.value - connection.value.unavailableSince,
        // Whether the platform refused the last wake for spent hours; addressed to the owner, who can buy the plan.
        hoursSpent: activeWakeRefused.value !== undefined,
        owner: active.value?.role === `owner`,
    }),
);

// Carries the sandbox id so /setup resumes this sandbox rather than offering a blank create form.
const setupTo = computed(() => ({ path: `/setup`, query: { sandbox: active.value?.id } }));
// Drops both credentials so re-establishing goes through a fresh Google proof with the account chooser.
const signIn = async (): Promise<void> => {
    clearCredential();
    invalidateSession();
    // Awaited, not fired and forgotten: the promise is what holds the button while the token is fetched.
    await getSessionToken();
};
</script>

<template>
    <GateCard icon="box" :title="notice.title" :spinner="notice.action === undefined">
        <p class="text-sm text-muted">{{ notice.body }}</p>
        <template #actions>
            <Button
                v-if="notice.action?.kind === `setup`"
                :as="RouterLink"
                :to="setupTo"
                :label="notice.action.label"
                icon-pos="right"
                severity="secondary"
            >
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
            <Button
                v-else-if="notice.action?.kind === `signin`"
                :label="notice.action.label"
                icon-pos="right"
                severity="secondary"
                @click="signIn"
            >
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
            <!-- The plan and the free alternative, side by side; the free option must never read as lesser. -->
            <template v-else-if="notice.action?.kind === `billing`">
                <Button :as="RouterLink" to="/settings/billing" :label="notice.action.label" icon-pos="right" class="ui-button-loud">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
                <Button :as="RouterLink" :to="setupTo" label="Run it on my computer" severity="secondary" />
            </template>
        </template>
    </GateCard>
</template>
