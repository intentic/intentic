<script setup lang="ts">
import { Button, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { type RememberedAccount,type RememberedSandbox,rememberedAccount } from "../../../client/directory/deviceDirectory";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { healthAnswers } from "../../../client/endpoint/endpoint";
import { browserSupportsPasskeys, signInWithPasskey } from "../../../client/session/passkeySignIn";
import { useSandboxSession } from "../../../client/session/sandboxSession";
import { accountFromProof, enterDirectMode, sandboxAt } from "./directMode";

// The outage screen's way through (PlatformUnavailable.vue): the sandboxes this device remembers, each checked from
// this browser and opened directly with one press (directMode.ts), the sandbox an /open link named first. Nothing is
// drawn on a device that remembers nothing and was handed no address. A device that remembers no account names the
// reader by a session it already holds on the sandbox, or asks: Google's sign-in, or a passkey registered with that
// sandbox, which is the one way in for an account with no Google sign-in while the platform cannot vouch for it.

const props = defineProps<{ readonly focusUrl?: string | undefined }>();

const t = useT();
const router = useRouter();
const { getIdToken } = useGoogleIdentity();
const { heldSessionEmail, adoptSession } = useSandboxSession();
// Decided once: WebAuthn is a property of the window.
const passkeysWork = browserSupportsPasskeys();

// The account this device last saw list; none on a device the platform was down for from the start.
const account = rememberedAccount();

const entries = computed((): RememberedSandbox[] => {
    const remembered = account?.sandboxes ?? [];
    const focus = props.focusUrl;
    if (focus === undefined) {
        return [...remembered];
    }
    const known = remembered.find((entry) => entry.daemonUrl === focus);
    return [known ?? sandboxAt(focus), ...remembered.filter((entry) => entry.daemonUrl !== focus)];
});

type Liveness = `checking` | `answering` | `silent`;
const liveness = ref<Record<string, Liveness>>({});
const opening = ref<string | undefined>(undefined);
// The sandbox a device remembering no account is asking the reader to sign in to, by its address.
const choosing = ref<RememberedSandbox | undefined>(undefined);
// The reader closed Google's sign-in, which a device remembering no account needs before anything can be opened.
const declined = ref(false);
const passkeyNotice = ref<NoticeModel>();

const statusOf = (entry: RememberedSandbox): string => {
    const state = liveness.value[entry.daemonUrl] ?? `checking`;
    if (state === `answering`) {
        return t(`sandbox.directSandboxes.answering`);
    }
    return state === `silent` ? t(`sandbox.directSandboxes.silent`) : t(`sandbox.directSandboxes.checking`);
};

const placeOf = (entry: RememberedSandbox): string =>
    entry.daemonUrl === props.focusUrl ? t(`sandbox.directSandboxes.linked`) : new URL(entry.daemonUrl).host;
const initialOf = (name: string): string => name.trim().slice(0, 1).toUpperCase();

onMounted(async () => {
    await Promise.all(
        entries.value.map(async (entry) => {
            const answers = await healthAnswers(entry.daemonUrl, undefined);
            liveness.value = { ...liveness.value, [entry.daemonUrl]: answers ? `answering` : `silent` };
        }),
    );
});

// Opens the window on one sandbox as the account that names the reader.
const enter = async (holder: RememberedAccount, entry: RememberedSandbox): Promise<void> => {
    enterDirectMode(holder, entry);
    await router.replace(`/`);
};

// Opened even when the check said nothing answers: the workspace's own connection screen explains a sandbox that is
// down better than a disabled button would. With no account remembered, a session this browser holds there names the
// reader; failing that, the reader is asked how to sign in.
const open = async (entry: RememberedSandbox): Promise<void> => {
    const held = account === undefined ? heldSessionEmail(entry.id) : undefined;
    const holder = account ?? (held === undefined ? undefined : accountFromProof({ kind: `session`, email: held }));
    if (holder !== undefined) {
        await enter(holder, entry);
        return;
    }
    declined.value = false;
    passkeyNotice.value = undefined;
    choosing.value = entry;
};

const withGoogle = async (entry: RememberedSandbox): Promise<void> => {
    opening.value = entry.daemonUrl;
    try {
        const token = await getIdToken();
        const holder = token === undefined ? undefined : accountFromProof({ kind: `google`, idToken: token });
        if (holder === undefined) {
            declined.value = true;
            return;
        }
        await enter(holder, entry);
    } finally {
        opening.value = undefined;
    }
};

// A passkey registered with this sandbox opens it with no platform at all: the session it mints is kept under the id
// the window opens the sandbox by, so the workspace finds it rather than asking again.
const withPasskey = async (entry: RememberedSandbox): Promise<void> => {
    opening.value = entry.daemonUrl;
    passkeyNotice.value = undefined;
    try {
        const session = await signInWithPasskey({ sandboxId: entry.id, base: entry.daemonUrl, connectToken: undefined });
        adoptSession(entry.id, session);
        const holder = accountFromProof({ kind: `session`, email: session.email });
        if (holder !== undefined) {
            await enter(holder, entry);
        }
    } catch (error) {
        passkeyNotice.value = noticeFrom(error, t(`sandbox.signInWall.passkeySignInIncomplete`), { tone: `warning` });
    } finally {
        opening.value = undefined;
    }
};
</script>

<template>
    <section v-if="entries.length > 0" class="flex w-full max-w-sm flex-col gap-3 text-left">
        <div>
            <h2 class="text-sm font-semibold">{{ t(`sandbox.directSandboxes.title`) }}</h2>
            <p class="mt-1 text-xs text-muted">{{ t(`sandbox.directSandboxes.detail`) }}</p>
        </div>
        <ul class="flex flex-col gap-2">
            <li v-for="entry in entries" :key="entry.daemonUrl" class="flex items-center gap-3 rounded-md border border-line bg-card px-3 py-2">
                <img v-if="entry.image" :src="entry.image" alt="" class="h-7 w-7 shrink-0 rounded" />
                <span v-else class="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-subtle/10 text-xs font-semibold">{{
                    initialOf(entry.name)
                }}</span>
                <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-medium">{{ entry.name }}</p>
                    <p class="truncate text-2xs text-muted">{{ placeOf(entry) }} · {{ statusOf(entry) }}</p>
                </div>
                <Button
                    :label="t(`sandbox.directSandboxes.open`)"
                    size="small"
                    :tier="liveness[entry.daemonUrl] === `answering` ? `accent` : `boring`"
                    :loading="opening === entry.daemonUrl"
                    :disabled="opening !== undefined"
                    @click="open(entry)"
                />
            </li>
        </ul>
        <!-- No account on this device: how to say who is opening it. -->
        <div v-if="choosing" class="flex flex-col gap-2 rounded-md border border-line bg-card px-3 py-3">
            <p class="text-xs text-muted">{{ t(`sandbox.directSandboxes.whoIsOpening`, { name: choosing.name }) }}</p>
            <div class="flex flex-wrap gap-2">
                <Button
                    :label="t(`auth.words.continueGoogle`)"
                    size="small"
                    tier="boring"
                    :disabled="opening !== undefined"
                    :loading="opening === choosing.daemonUrl"
                    @click="withGoogle(choosing)"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>
                <Button
                    v-if="passkeysWork"
                    :label="t(`sandbox.signInWall.usePasskey2`)"
                    size="small"
                    tier="boring"
                    :disabled="opening !== undefined"
                    @click="withPasskey(choosing)"
                >
                    <template #icon><Icon name="key" /></template>
                </Button>
            </div>
            <p v-if="passkeysWork" class="text-2xs text-subtle">{{ t(`sandbox.directSandboxes.passkeyNote`) }}</p>
            <Notice v-if="passkeyNotice" :of="passkeyNotice" />
        </div>
        <p v-if="declined" class="text-xs text-warning">{{ t(`sandbox.directSandboxes.signInToOpen`) }}</p>
    </section>
</template>
