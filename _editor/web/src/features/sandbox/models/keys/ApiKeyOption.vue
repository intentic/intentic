<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { endpointProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import { keyBeside } from "@intentic/sandbox-contract/models/key-providers";
import { messageOr } from "@intentic/ui/async";
import { Button, Icon, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, useId, useTemplateRef } from "vue";
import { refreshConnections } from "../../../../models/conversations/accounts/useChat-accounts";
import { useCapabilities } from "../../../../models/capabilities/useCapabilities";

// AN API KEY, FOR WHOEVER DECIDES ON ONE. The same models a provider's sign-in reaches, paid per token to its vendor instead
// of through a plan. Never the default (owner, 2026-11-05): a key spends money a plan would not, so it stays one quiet line
// at the foot of the provider's card, and opening it says what it costs before it asks for anything. What it adds is a
// model endpoint, the same connection a key found on the owner's computer becomes (migrations/provider-keys.ts), which
// lands as a row of this same card (ProviderKeyRows), beside the accounts.

const t = useT();

const { provider } = defineProps<{ provider: AgentProvider }>();
// The endpoint the key became, and the vendor's name for it, for the page's own "connected" answer.
const emit = defineEmits<{ added: [endpoint: AgentProvider, label: string] }>();

const vendor = computed(() => keyBeside(provider));
const { capabilities, add, remove, refetch } = useCapabilities();

const open = ref(false);
const key = ref(``);
const problem = ref<string | undefined>(undefined);
const busy = ref(false);
const fieldId = useId();
const field = useTemplateRef<HTMLInputElement>(`field`);

const show = async (): Promise<void> => {
    open.value = true;
    await nextTick();
    field.value?.focus();
};
const close = (): void => {
    open.value = false;
    key.value = ``;
    problem.value = undefined;
};

// Named for the vendor, numbered only when taken, as a found key's endpoint is.
const nameFor = (base: string): string => {
    const taken = new Set((capabilities.value ?? []).map((entry) => entry.id));
    let name = base;
    for (let n = 2; taken.has(name); n += 1) {
        name = `${base}-${n}`;
    }
    return name;
};

// An endpoint is stored whether or not its server answers (endpoint.handler.ts), which is right for a server still
// starting and wrong for a mistyped key: one the vendor lists no models for is taken back out, and said at the field.
const submit = async (): Promise<void> => {
    const entry = vendor.value;
    const value = key.value.trim();
    if (entry === undefined || value === `` || busy.value) {
        return;
    }
    busy.value = true;
    problem.value = undefined;
    const id = nameFor(entry.id);
    try {
        await add({ id, kind: `endpoint`, config: { baseUrl: entry.baseUrl, protocol: entry.protocol, apiKey: value } });
        const status = (await refetch()).data?.capabilities.find((held) => held.id === id)?.status;
        if (status !== undefined && status.state !== `active`) {
            await remove.mutateAsync(id);
            problem.value = t(`connect.apiKey.notAccepted`, { vendor: entry.label });
            return;
        }
        // Said before the connections are read again: that read lists the key as a row of this card, which takes this
        // line's place, and an unmounted component's word reaches nobody.
        emit(`added`, endpointProvider(id), entry.label);
        close();
        await refreshConnections();
    } catch (caught) {
        problem.value = messageOr(caught, t(`connect.apiKey.couldntAdd`, { vendor: entry.label }));
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <RowNote v-if="vendor" variant="block">
        <!-- Folded: one quiet line, so the sign-in above stays the way in. -->
        <button v-if="!open" type="button" :class="ui.textButton({ tone: `subtle`, size: `xs` })" @click="show">
            <Icon name="key" class="text-2xs" />{{ t(`connect.apiKey.offer`, { vendor: vendor.label }) }}
        </button>

        <!-- Opened: what it costs first, then the field. -->
        <div v-else class="flex max-w-xl flex-col gap-3 text-xs">
            <div class="flex flex-col gap-1">
                <p class="text-sm font-medium text-content">{{ t(`connect.apiKey.title`, { vendor: vendor.label }) }}</p>
                <p class="text-muted">{{ t(`connect.apiKey.billing`, { vendor: vendor.label }) }}</p>
                <p class="text-muted">{{ t(`connect.apiKey.limit`, { vendor: vendor.label }) }}</p>
                <span class="flex flex-wrap gap-x-4 gap-y-1">
                    <a v-if="vendor.pricingUrl" :href="vendor.pricingUrl" target="_blank" rel="noopener noreferrer" :class="ui.textButton({ size: `xs` })">
                        {{ t(`connect.apiKey.prices`) }}<Icon name="external-link" />
                    </a>
                    <a v-if="vendor.keysUrl" :href="vendor.keysUrl" target="_blank" rel="noopener noreferrer" :class="ui.textButton({ size: `xs` })">
                        {{ t(`connect.apiKey.createKey`) }}<Icon name="external-link" />
                    </a>
                </span>
            </div>
            <label :for="fieldId" class="sr-only">{{ t(`connect.apiKey.field`, { vendor: vendor.label }) }}</label>
            <div class="flex gap-2">
                <input
                    :id="fieldId"
                    ref="field"
                    v-model="key"
                    type="password"
                    name="providerApiKey"
                    autocomplete="off"
                    :placeholder="t(`connect.apiKey.placeholder`, { vendor: vendor.label })"
                    :class="ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                    @keydown.enter="submit"
                />
                <Button tier="accent" size="small" :label="t(`connect.apiKey.add`)" :loading="busy" :disabled="key.trim() === ``" @click="submit" />
                <Button tier="quiet" size="small" :label="t(`ui.action.cancel`)" :disabled="busy" @click="close" />
            </div>
            <p v-if="problem" role="alert" class="text-danger">{{ problem }}</p>
        </div>
    </RowNote>
</template>
