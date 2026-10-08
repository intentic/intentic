<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { healthAnswers } from "../../../client/endpoint/endpoint";
import { type RememberedSandbox, rememberedAccount } from "../../../client/directory/deviceDirectory";
import { accountFromGoogle, enterDirectMode, sandboxAt } from "./directMode";

// The outage screen's way through (PlatformUnavailable.vue): the sandboxes this device remembers, each checked from
// this browser and opened directly with one press (directMode.ts), the sandbox an /open link named first. Nothing is
// drawn on a device that remembers nothing and was handed no address.

const props = defineProps<{ readonly focusUrl?: string | undefined }>();

const t = useT();
const router = useRouter();
const { getIdToken } = useGoogleIdentity();

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
// The reader closed Google's sign-in, which a device remembering no account needs before anything can be opened.
const declined = ref(false);

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

// Opened even when the check said nothing answers: the workspace's own connection screen explains a sandbox that is
// down better than a disabled button would.
const open = async (entry: RememberedSandbox): Promise<void> => {
    opening.value = entry.daemonUrl;
    try {
        const token = account === undefined ? await getIdToken() : undefined;
        const holder = account ?? (token === undefined ? undefined : accountFromGoogle(token));
        if (holder === undefined) {
            declined.value = true;
            return;
        }
        enterDirectMode(holder, entry);
        await router.replace(`/`);
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
        <p v-if="declined" class="text-xs text-warning">{{ t(`sandbox.directSandboxes.signInFirst`) }}</p>
    </section>
</template>
