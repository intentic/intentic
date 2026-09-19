<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSession } from "../client/sandboxSession";
import { useSandbox } from "../client/useSandbox";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { restartExpected } from "../live/sandboxRestart";
import { connectionNotice } from "./connectionNotice";
import { stalledPaths } from "../../../app/perf";
import { DEADLINE_MS } from "../client/sandboxAuthFetch";
import { useT } from "@intentic/ui/i18n";

// Shown whenever the active sandbox's daemon isn't reachable. What it says is a pure function of the classified
// failure (connectionNotice), so setup, sign-in and account-mismatch causes each get their own words and action.
// Flips to the real views the moment the daemon answers.

const t = useT();

const { active, connection, activeWakeRefused } = useSandbox();
const { clearCredential } = useGoogleIdentity();
const { invalidateSession, getSessionToken } = useSandboxSession();

// Runs only while an outage is ongoing; a connected workspace pays nothing for the clock.
const timing = computed(() => connection.value.unavailableSince !== undefined);
const now = useNow(timing);
// Why the platform refused the last wake, if it did: spent hours (the owner can buy the plan) or the owner's hosted
// lane switched off (nothing here can lift it).
const refusal = computed(() => activeWakeRefused.value?.kind);
// What is ESTABLISHED about this sandbox, apart from its connection: each of these is why the notice is allowed to
// name a cause rather than describe a silence.
const known = computed(() => {
    const box = active.value;
    return {
        sandboxName: box?.name,
        // A machine the platform started for this sandbox, which earns the gate the right to name a cause.
        hostedMachine: (box?.hosted ?? null) !== null,
        owner: box?.role === `owner`,
        // The machine that deleted this sandbox's container reported it on the way out; nothing else can establish this.
        removed: (box?.removedAt ?? null) !== null,
        removedBy: box?.removedBy ?? null,
    };
});

// Survives the reload as well as the swap (sandboxRestart.ts keeps it in storage), which is what lets a tab opened
// mid-restart say why this sandbox is quiet instead of asking its reader to guess.
const restart = computed(() => restartExpected(active.value?.id)?.quiet);

// Only spans that reached the client's own deadline count, and only from this outage: slowness is not a stall, and a
// route that timed out before the sandbox went quiet explains nothing about why it is quiet now.
const stalledPath = computed(() =>
    connection.value.unavailableSince === undefined ? undefined : stalledPaths(DEADLINE_MS, now.value - connection.value.unavailableSince)[0],
);

const notice = computed(() =>
    connectionNotice({
        ...known.value,
        restart: restart.value,
        failure: connection.value.failure,
        outageMs: connection.value.unavailableSince === undefined ? 0 : now.value - connection.value.unavailableSince,
        hoursSpent: refusal.value === `hours`,
        suspended: refusal.value === `suspended`,
        stalledPath: stalledPath.value,
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
    <!-- The spinner follows what the notice says is still expected, not whether there's a button. -->
    <GateCard icon="box" :title="notice.title" :spinner="notice.waiting">
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
            <Button v-else-if="notice.action?.kind === `signin`" :label="notice.action.label" icon-pos="right" severity="secondary" @click="signIn">
                <template #icon><Icon name="arrow-right" /></template>
            </Button>
            <!-- The plan and the free alternative, side by side; the free option must never read as lesser. -->
            <template v-else-if="notice.action?.kind === `billing`">
                <Button :as="RouterLink" to="/settings/billing" :label="notice.action.label" icon-pos="right" class="ui-button-loud">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
                <Button :as="RouterLink" :to="setupTo" :label="t(`sandbox.sandboxConnecting.runOnMyComputer`)" severity="secondary" />
            </template>
        </template>
    </GateCard>
</template>
