<!-- Where a secret may go before anybody is asked: any host, or only the ones listed. Read as its answer, changed in a panel hanging off it. -->
<script setup lang="ts">
import { Button, type NoticeModel, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { normalizeHostPattern, SECRET_HOSTS_MAX } from "@intentic/sandbox-contract/policy/secret-hosts";
import { computed, ref } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates, useSecretHosts } from "../../../../models/capabilities/useSecrets";
import SecretChoice from "./SecretChoice.vue";
import SecretFact from "./SecretFact.vue";
import SecretPopover from "./SecretPopover.vue";
import { EDITABLE_VALUE, FIXED_VALUE, VALUE_NOTE, VALUE_TEXT } from "./secretLook";

// The host guard: on, a use goes unasked only to the hosts listed, and anything else, or anything whose destination a
// command does not show, waits for a click in the chat; off, it never asks. Off for most secrets, on from the start for
// a connector's credential with its service's own hosts. Turning it off keeps the list, for turning it back on.

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();

// Only the owner turns a guard off or adds a host (the daemon's rule); everybody else reads it.
const { isOwner } = useCredentialGates();
const { setHosts } = useSecretHosts();

const stored = computed(() => row.entry.hosts);
const storedOn = computed(() => stored.value?.guard === true);
const storedList = computed(() => stored.value?.list ?? []);

const said = computed(() => {
    if (!storedOn.value) {
        return t(`capabilities.secretHosts.anyHost`);
    }
    return storedList.value.length > 0 ? storedList.value.join(`, `) : t(`capabilities.secretHosts.noHost`);
});
const note = computed<string | undefined>(() => {
    if (!storedOn.value) {
        return undefined;
    }
    const asks = storedList.value.length > 0 ? t(`capabilities.secretHosts.elsewhereAsks`) : t(`capabilities.secretHosts.everyUseAsks`);
    return stored.value?.source === `connector` ? `${asks} · ${t(`capabilities.secretHosts.byConnector`)}` : asks;
});

const anchor = ref<HTMLElement>();
const open = ref(false);
const guard = ref(false);
const draft = ref<string[]>([]);
const typed = ref(``);
const typedError = ref<string | undefined>(undefined);
const saving = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

const begin = (): void => {
    guard.value = storedOn.value;
    draft.value = [...storedList.value];
    typed.value = ``;
    typedError.value = undefined;
    error.value = undefined;
    open.value = true;
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

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((entry) => right.includes(entry));
const changed = computed(() => guard.value !== storedOn.value || !sameList(storedList.value, draft.value));

const save = async (): Promise<void> => {
    if (row.gateSubject === undefined) {
        return;
    }
    // A host still in the box counts as meant: Save adds it rather than dropping what was typed.
    if (typed.value.trim() !== ``) {
        add();
        if (typedError.value !== undefined) {
            return;
        }
    }
    if (!changed.value) {
        open.value = false;
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        await setHosts.mutateAsync({
            subject: row.gateSubject,
            kind: row.entry.kind === `capability` ? `capability` : `secret`,
            guard: guard.value,
            hosts: [...draft.value],
        });
        open.value = false;
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretHosts.couldNotSave`));
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <SecretFact :label="t(`capabilities.secretHosts.label`)">
        <button
            v-if="isOwner"
            ref="anchor"
            type="button"
            :class="EDITABLE_VALUE"
            :aria-label="t(`capabilities.secretHosts.change`, { now: said })"
            @click="begin"
        >
            <span :class="[VALUE_TEXT, storedOn && storedList.length > 0 ? `[overflow-wrap:anywhere] font-mono` : ``]">{{ said }}</span>
            <span v-if="note" :class="VALUE_NOTE">{{ note }}</span>
        </button>
        <span v-else :class="FIXED_VALUE">
            <span :class="[VALUE_TEXT, storedOn && storedList.length > 0 ? `[overflow-wrap:anywhere] font-mono` : ``]">{{ said }}</span>
            <span v-if="note" :class="VALUE_NOTE">{{ note }}</span>
        </span>

        <SecretPopover
            v-model="open"
            :anchor="anchor"
            :header="t(`capabilities.secretHosts.label`)"
            :saving="saving"
            :error="error"
            wide
            @save="save"
        >
            <div class="flex flex-col gap-1" role="radiogroup" :aria-label="t(`capabilities.secretHosts.label`)">
                <SecretChoice
                    :checked="!guard"
                    :title="t(`capabilities.secretHosts.anyHost`)"
                    :note="t(`capabilities.secretHosts.anyHostChoice`)"
                    @pick="guard = false"
                />
                <SecretChoice
                    :checked="guard"
                    :title="t(`capabilities.secretHosts.onlyThese`)"
                    :note="t(`capabilities.secretHosts.onlyTheseChoice`)"
                    @pick="guard = true"
                />
            </div>

            <div v-if="guard" class="flex flex-col gap-2 pl-9">
                <p v-if="stored?.source === `connector`" class="text-xs text-subtle">{{ t(`capabilities.secretHosts.fromConnector`) }}</p>
                <div v-if="draft.length > 0" class="flex flex-wrap gap-1">
                    <span v-for="host of draft" :key="host" :class="ui.chip({ on: true, trail: true }, `font-mono`)">
                        {{ host }}
                        <button
                            type="button"
                            :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `-my-0.5`)"
                            :aria-label="t(`capabilities.secretHosts.removeHost`, { host })"
                            @click="removeHost(host)"
                        >
                            <Icon name="times" class="text-2xs" />
                        </button>
                    </span>
                </div>
                <p v-else class="text-xs text-warning">{{ t(`capabilities.secretHosts.emptyList`) }}</p>
                <form class="flex items-center gap-2" @submit.prevent="add">
                    <input
                        v-model="typed"
                        type="text"
                        autocomplete="off"
                        spellcheck="false"
                        :placeholder="t(`capabilities.secretHosts.placeholder`)"
                        :aria-label="t(`capabilities.secretHosts.addHost`)"
                        :class="ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                    />
                    <Button type="submit" size="small" tier="boring" :label="t(`capabilities.secretHosts.add`)" :disabled="typed.trim() === ``">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </form>
                <p v-if="typedError" class="text-xs text-warning">{{ typedError }}</p>
            </div>
        </SecretPopover>
    </SecretFact>
</template>
