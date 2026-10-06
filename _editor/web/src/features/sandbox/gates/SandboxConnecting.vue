<script setup lang="ts">
import { Button } from "@intentic/ui";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useSandboxSession } from "../../../client/session/sandboxSession";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { restartExpected } from "../live/sandboxRestart";
import { type ConnectionNotice, connectionNotice, stalledBody } from "./connectionNotice";
import SandboxRecovery from "./SandboxRecovery.vue";
import { useDiagnosisNotice, useRecoveryDue, useVisibleOutage } from "./useVisibleOutage";
import { stalledPaths } from "../../../app/perf";
import { DEADLINE_MS } from "../../../client/sandbox/sandboxAuthFetch";
import { useT } from "@intentic/ui/i18n";

// Shown whenever the active sandbox's daemon isn't reachable. What it says is a pure function of the classified
// failure (connectionNotice), so setup, sign-in and account-mismatch causes each get their own words and action.
// Flips to the real views the moment the daemon answers.

const t = useT();

const { active, connection, activeWakeRefused } = useSandbox();
const { clearCredential } = useGoogleIdentity();
const { invalidateSession, getSessionToken } = useSandboxSession();

const outage = useVisibleOutage();
const outageMs = outage.elapsed;
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
        // A machine picked its setup up: a missing address is one on its way for a while (connectionNotice.ts).
        claimed: (box?.setupCodeClaimedAt ?? null) !== null,
    };
});

// Survives the reload as well as the swap (sandboxRestart.ts keeps it in storage), which is what lets a tab opened
// mid-restart say why this sandbox is quiet instead of asking its reader to guess.
const restart = computed(() => restartExpected(active.value?.id)?.quiet);

// Only spans that reached the client's own deadline count, and only from this outage: slowness is not a stall, and a
// route that timed out before the sandbox went quiet explains nothing about why it is quiet now.
const stalledPath = computed(() =>
    connection.value.unavailableSince === undefined ? undefined : stalledPaths(DEADLINE_MS, outageMs.value)[0],
);

// What the diagnosis of this silence established, in the gate's own shape. A route this browser watched run out its
// deadline says more about a busy sandbox than "busy" does, so it keeps its own sentence there.
const diagnosis = useDiagnosisNotice(outage);
const diagnosed = computed<ConnectionNotice | undefined>(() => {
    const found = diagnosis.value;
    if (found === undefined) {
        return undefined;
    }
    const stalled = found.chain.some((link) => link.id === `sandbox` && link.state === `working`) ? stalledBody(stalledPath.value) : undefined;
    return { title: found.title, body: stalled ?? found.body, action: undefined, waiting: found.waiting };
});

const notice = computed(() =>
    connectionNotice({
        ...known.value,
        restart: restart.value,
        failure: connection.value.failure,
        outageMs: outageMs.value,
        hoursSpent: refusal.value === `hours`,
        suspended: refusal.value === `suspended`,
        stalledPath: stalledPath.value,
        diagnosed: diagnosed.value,
    }),
);

// A cause with a way back gets the ways that need nothing from the sandbox (SandboxRecovery); any other diagnosis still
// shows its chain there, so "it's busy" can be seen to be true.
const recovering = useRecoveryDue(outage, diagnosis);
const explained = computed(() => notice.value === diagnosed.value && (diagnosis.value?.chain.length ?? 0) > 0);

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
                <Button :as="RouterLink" :to="setupTo" :label="t(`sandbox.words.runOnMyComputer`)" severity="secondary" />
            </template>
        </template>
        <template v-if="recovering || explained" #below>
            <div class="flex flex-col gap-3 border-t border-line pt-4">
                <p v-if="recovering" class="text-left text-sm font-medium text-content">{{ t(`sandbox.sandboxRecovery.gateHeading`) }}</p>
                <SandboxRecovery />
            </div>
        </template>
    </GateCard>
</template>
