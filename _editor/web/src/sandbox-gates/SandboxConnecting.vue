<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSession } from "../composables/sandbox/sandboxSession";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { connectionNotice } from "./connectionNotice";

/* Shown in the workspace outlet whenever the active sandbox's daemon isn't reachable (see SandboxGate). What
 * it says is a pure function of the CLASSIFIED connection failure (connectionNotice) rather than of a boolean
 * "did a probe fail", so a sandbox that never announced itself, one that stopped answering mid-session, and
 * an expired Google session each get their own words and their own offered action instead of sharing one
 * "unreachable" screen. The connection machine flips to `online` the moment the daemon answers, and the real
 * views render. */

const { active, connection } = useSandbox();
const { clearCredential } = useGoogleIdentity();
const { invalidateSession, getSessionToken } = useSandboxSession();

/* THE ONE CLOCK ON THIS SCREEN, and it runs only while there is a running outage to time: a wait that has
 * lasted a minute on a machine WE run is a different sentence from the same wait at ten seconds
 * (connectionNotice), and nothing else here changes with time. Stopped the moment the failure clears, so a
 * connected workspace pays nothing for it. */
const timing = computed(() => connection.value.unavailableSince !== undefined);
const now = useNow(timing);
const notice = computed(() =>
    connectionNotice({
        failure: connection.value.failure,
        sandboxName: active.value?.name,
        // A machine the platform started for this sandbox: the row says so, and it is what earns this gate the
        // right to name a cause instead of waiting politely forever.
        hostedMachine: (active.value?.hosted ?? null) !== null,
        outageMs: connection.value.unavailableSince === undefined ? 0 : now.value - connection.value.unavailableSince,
    }),
);

// Carry the sandbox id so /setup resumes THIS sandbox instead of offering a blank create form.
// Carried as a link rather than pushed, so the one way out of this gate has an address on it like everything
// else that goes somewhere.
const setupTo = computed(() => ({ path: `/setup`, query: { sandbox: active.value?.id } }));
// Drop both credentials so the re-establish goes through a fresh Google proof (with the account chooser:
// clearCredential disables auto-select) instead of replaying whatever the daemon just refused.
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
        </template>
    </GateCard>
</template>
