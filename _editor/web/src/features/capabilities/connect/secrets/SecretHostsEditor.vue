<script setup lang="ts">
import { Notice, type NoticeModel, ui, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { normalizeHostPattern, SECRET_HOSTS_MAX } from "@intentic/sandbox-contract";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates, useSecretHosts } from "./useSecrets";

// The host guard, the second half of a secret's "Needs approval" section, under the named approver: on, a use goes
// unasked only to the hosts listed here and anything else waits for a click in the chat; off, it never asks. Off for most
// secrets, on from the start for a connector's credential with its service's own hosts. The draft stays local until the
// owner saves, like the approver editor above it, so a half-typed list never guards anything.

const t = useT();

const { row, expanded } = defineProps<{ row: SecretRow; expanded: boolean }>();

// Only the owner turns a guard off or adds a host (the daemon's rule); everybody else reads it.
const { isOwner } = useCredentialGates();
const { setHosts } = useSecretHosts();

const stored = computed(() => row.entry.hosts);
const storedOn = computed(() => stored.value?.guard === true);
const kind = computed(() => (row.entry.kind === `capability` ? (`capability` as const) : (`secret` as const)));
const draftOn = ref(false);
const draft = ref<string[]>([]);
const typed = ref(``);
const typedError = ref<string | undefined>(undefined);
const error = ref<NoticeModel | undefined>(undefined);
// On when the guard is on, or when the owner has opened the editor to turn it on.
const on = computed(() => storedOn.value || draftOn.value);

// Re-syncs to the server's setting whenever the row opens or the setting changes, so a stale draft can't overwrite
// another tab's edit.
watch(
    [() => expanded, stored],
    () => {
        draftOn.value = false;
        draft.value = [...(stored.value?.list ?? [])];
        typed.value = ``;
        typedError.value = undefined;
        error.value = undefined;
    },
    { immediate: true },
);

const save = async (guard: boolean, hosts: readonly string[]): Promise<void> => {
    error.value = undefined;
    if (row.gateSubject === undefined) {
        return;
    }
    try {
        await setHosts.mutateAsync({ subject: row.gateSubject, kind: kind.value, guard, hosts: [...hosts] });
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretHosts.couldNotSave`));
    }
};

const saveDraft = (): Promise<void> => save(true, draft.value);

// Turning off saves at once and keeps the hosts for later; turning on opens the draft with the hosts it had.
const toggle = (next: boolean): void => {
    if (next) {
        draftOn.value = true;
        draft.value = [...(stored.value?.list ?? [])];
        return;
    }
    if (storedOn.value) {
        void save(false, stored.value?.list ?? []);
        return;
    }
    draftOn.value = false;
    draft.value = [...(stored.value?.list ?? [])];
};

// A pasted URL counts as its host, the way the daemon reads one; anything that is still not a host is said here.
const add = (): void => {
    const host = normalizeHostPattern(typed.value);
    if (host === undefined) {
        typedError.value = t(`capabilities.secretHosts.notAHost`);
        return;
    }
    typedError.value = undefined;
    typed.value = ``;
    if (!draft.value.includes(host) && draft.value.length < SECRET_HOSTS_MAX) {
        draft.value = [...draft.value, host];
    }
};

const removeHost = (host: string): void => {
    draft.value = draft.value.filter((entry) => entry !== host);
};

// Turning on is always a change; with the guard already on, only a different list is.
const dirty = computed(() => {
    const list = stored.value?.list ?? [];
    return !storedOn.value || list.length !== draft.value.length || !list.every((host) => draft.value.includes(host));
});
</script>

<template>
    <div class="pt-3">
        <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-content">{{ t(`capabilities.secretHosts.title`) }}</span>
            <ToggleSwitch
                v-if="isOwner"
                :model-value="on"
                v-tooltip.top="
                    on
                        ? { title: t(`capabilities.secretHosts.turnOff`), note: t(`capabilities.secretHosts.turnOffNote`) }
                        : { title: t(`capabilities.secretHosts.turnOn`), note: t(`capabilities.secretHosts.turnOnNote`) }
                "
                :aria-label="t(`capabilities.secretHosts.title`)"
                @update:model-value="toggle"
            />
        </div>

        <!-- Not the owner: the guard as it stands, and whose it is to change, rather than controls that would be refused. -->
        <p v-if="!isOwner" class="pt-0.5 text-2xs text-muted">
            <template v-if="storedOn && stored && stored.list.length > 0">{{
                t(`capabilities.secretHosts.onlyToReadOnly`, { hosts: stored.list.join(`, `) })
            }}</template>
            <template v-else-if="storedOn">{{ t(`capabilities.secretHosts.everyUseReadOnly`) }}</template>
            <template v-else>{{ t(`capabilities.secretHosts.offReadOnly`) }}</template>
        </p>

        <template v-else-if="on">
            <p class="pt-1 text-2xs text-muted">{{ t(`capabilities.secretHosts.explain`) }}</p>
            <p v-if="stored?.source === `connector`" class="pt-0.5 text-2xs text-subtle">{{ t(`capabilities.secretHosts.fromConnector`) }}</p>
            <div v-if="draft.length > 0" class="flex flex-wrap gap-1 pt-1">
                <span v-for="host of draft" :key="host" class="ui-chip ui-chip-on gap-1 py-1 pl-2 pr-1 font-mono text-2xs">
                    {{ host }}
                    <button
                        type="button"
                        :class="ui.iconButton(`size-4 text-subtle`)"
                        :aria-label="t(`capabilities.secretHosts.removeHost`, { host })"
                        @click="removeHost(host)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </span>
            </div>
            <p v-else class="pt-1 text-2xs text-warning">{{ t(`capabilities.secretHosts.everyUseAsks`) }}</p>
            <form class="flex flex-wrap items-center gap-2 pt-1.5" @submit.prevent="add">
                <input
                    v-model="typed"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t(`capabilities.secretHosts.placeholder`)"
                    :aria-label="t(`capabilities.secretHosts.addHost`)"
                    :class="ui.inputSm(`min-w-40 flex-1 font-mono`)"
                />
                <button type="submit" :class="ui.linkButton(`text-2xs`)" :disabled="typed.trim() === ``">
                    {{ t(`capabilities.secretHosts.addHost`) }}
                </button>
            </form>
            <p v-if="typedError" class="pt-1 text-2xs text-warning">{{ typedError }}</p>
            <div class="flex items-center gap-2 pt-2">
                <button type="button" :class="ui.linkButton(`text-2xs`)" :disabled="!dirty" v-action="saveDraft">
                    {{ storedOn ? t(`ui.action.save`) : t(`capabilities.secretHosts.turnOn`) }}
                </button>
            </div>
        </template>
        <p v-else class="pt-0.5 text-2xs text-muted">
            {{ t(`capabilities.secretHosts.off`) }}
            <template v-if="stored && stored.list.length > 0">{{ t(`capabilities.secretHosts.keeps`, { hosts: stored.list.join(`, `) }) }}</template>
        </p>
        <Notice v-if="error" :of="error" class="mt-2" />
    </div>
</template>
