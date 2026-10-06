<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useAuth } from "../../../client/auth/useAuth";
import { normalizeDaemonUrl } from "../../../lib/daemonUrl";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { rememberedAccount } from "../../../client/directory/deviceDirectory";
import { liveRecoveryDeps } from "./recoveryDeps";
import { type Candidate, useRecovery } from "./useRecovery";

// /recover: the sandboxes this device remembers and the account's list lacks, each checked and offered back with one
// press (useRecovery.ts). Reached instead of onboarding when a list offers nothing to open but this device remembers
// sandboxes of the account's own (router/index.ts), from the lost-sandboxes card, and from an /open link to a sandbox
// the list lacks. Nothing left to bring back sends the reader on, to the workspace or to setup.

const t = useT();
const route = useRoute();
const router = useRouter();
const { user } = useAuth();
const { sandboxes } = useSandbox();

// Behind requireAuth, so an account is always there; an empty email remembers nothing and offers nothing.
const email = user.value?.email ?? ``;
// The address an /open link named, when it is one.
const named = [route.query[`url`]].flat()[0];
const asked = named === null || named === undefined ? undefined : normalizeDaemonUrl(named);

const { candidates, checked, recoverable, reconnected, busy, check, reconnect, reconnectAll, forget } = useRecovery(liveRecoveryDeps(email, asked));

// Another database than the one this device remembered, which says more than "lost track of".
const reset = computed(() => rememberedAccount(email)?.resetSince !== undefined);
const hasWorkspace = computed(() => sandboxes.value.some((entry) => entry.lastSeenAt !== null));
const anyOffline = computed(() => candidates.value.some((candidate) => candidate.state.kind === `offline`));

const statusOf = (candidate: Candidate): string => {
    switch (candidate.state.kind) {
        case `checking`:
            return t(`sandbox.recover.checking`);
        case `recoverable`:
            return t(`sandbox.recover.recoverable`);
        case `reconnecting`:
            return t(`sandbox.recover.reconnecting`);
        case `reconnected`:
            return candidate.state.byAddress ? t(`sandbox.recover.reconnectedByAddress`) : t(`sandbox.recover.reconnected`);
        case `offline`:
            return t(`sandbox.recover.offline`);
        case `shared`:
            return t(`sandbox.recover.shared`);
        case `failed`:
            return candidate.state.message;
    }
};

const toneOf = (candidate: Candidate): string => {
    if (candidate.state.kind === `reconnected`) {
        return `text-success`;
    }
    return candidate.state.kind === `failed` ? `text-danger` : `text-muted`;
};

const hostOf = (daemonUrl: string): string => new URL(daemonUrl).host;
const initialOf = (name: string): string => name.trim().slice(0, 1).toUpperCase();

const open = async (): Promise<void> => {
    await router.push(`/`);
};

onMounted(async () => {
    await check();
    if (candidates.value.length === 0) {
        await router.replace(hasWorkspace.value ? `/` : `/setup`);
    }
});
</script>

<template>
    <main class="flex min-h-dvh items-center justify-center bg-canvas px-4 py-8 text-content">
        <section class="flex w-full max-w-lg flex-col gap-5">
            <header class="flex flex-col gap-1">
                <h1 class="text-lg font-semibold">{{ t(`sandbox.recover.title`) }}</h1>
                <p class="text-xs text-muted">{{ reset ? t(`sandbox.recover.recordsReset`) : t(`sandbox.recover.lostTrack`) }}</p>
            </header>

            <ul class="flex flex-col gap-2" :aria-busy="busy">
                <li
                    v-for="candidate in candidates"
                    :key="candidate.entry.daemonUrl"
                    class="flex items-center gap-3 rounded-md border border-line bg-card px-3 py-2"
                >
                    <img v-if="candidate.entry.image" :src="candidate.entry.image" alt="" class="h-8 w-8 shrink-0 rounded" />
                    <span v-else class="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-subtle/10 text-xs font-semibold">{{
                        initialOf(candidate.entry.name)
                    }}</span>
                    <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-medium">{{ candidate.entry.name }}</p>
                        <p class="truncate text-2xs text-muted">{{ hostOf(candidate.entry.daemonUrl) }}</p>
                        <p class="text-2xs" :class="toneOf(candidate)">{{ statusOf(candidate) }}</p>
                    </div>
                    <Button
                        v-if="candidate.state.kind === `recoverable`"
                        :label="t(`sandbox.recover.reconnect`)"
                        size="small"
                        @click="reconnect(candidate.entry, candidate.state.sandboxId)"
                    />
                    <Button
                        v-else-if="candidate.state.kind === `failed` && candidate.state.sandboxId !== undefined"
                        :label="t(`ui.action.tryAgain`)"
                        severity="secondary"
                        size="small"
                        @click="reconnect(candidate.entry, candidate.state.sandboxId)"
                    />
                    <button
                        v-else-if="candidate.state.kind === `offline` || candidate.state.kind === `shared`"
                        type="button"
                        :class="ui.linkButton(`text-2xs text-muted`)"
                        @click="forget(candidate.entry)"
                    >
                        {{ t(`sandbox.recover.forget`) }}
                    </button>
                    <Icon v-else-if="candidate.state.kind === `checking` || candidate.state.kind === `reconnecting`" name="spinner" class="animate-spin text-muted" />
                    <Icon v-else name="check-circle" class="text-success" />
                </li>
            </ul>

            <div class="flex flex-wrap items-center gap-2">
                <Button v-if="recoverable > 1" :label="t(`sandbox.recover.reconnectAll`)" :disabled="busy" @click="reconnectAll" />
                <Button
                    v-if="reconnected > 0"
                    :label="t(`sandbox.recover.openWorkspace`)"
                    :severity="recoverable > 0 ? `secondary` : undefined"
                    @click="open"
                />
                <Button v-if="checked && anyOffline" :label="t(`sandbox.recover.checkAgain`)" severity="secondary" :disabled="busy" @click="check" />
            </div>

            <RouterLink to="/setup" :class="ui.linkButton(`self-start text-xs text-muted`)">{{ t(`sandbox.recover.setUpNew`) }}</RouterLink>
        </section>
    </main>
</template>
