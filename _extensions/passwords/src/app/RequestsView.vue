<!-- The agents waiting for a password: who asks, for which place and why, the password that fits, and the person's answer. -->
<script setup lang="ts">
import { Button, Icon, messageOr, Notice, ui } from "@intentic/extension-ui";
import { timeAgo } from "@intentic/extension-ui/format";
import type { KeyringNeedAnswer } from "@intentic/sandbox-contract/schemas/keyring";
import { computed, reactive, ref } from "vue";
import { t } from "../i18n.js";
import type { PasswordItem, PasswordRequest, PasswordsPort } from "./port.js";
import { originLabel } from "./words.js";

const { requests, items, port, now } = defineProps<{
    requests: readonly PasswordRequest[];
    items: readonly PasswordItem[];
    port: PasswordsPort;
    now: number;
}>();
const emit = defineEmits<{ answered: [] }>();

// Per request: the password picked when several fit, the value typed when none does, and what went wrong.
const picked = reactive(new Map<string, string>());
const typed = reactive(new Map<string, string>());
const errors = reactive(new Map<string, string>());
const waiting = ref<string | undefined>(undefined);

const titleOf = (name: string): string => items.find((item) => item.name === name)?.title ?? name;
const usernameOf = (name: string): string | undefined => items.find((item) => item.name === name)?.username;

const headline = (request: PasswordRequest): string => {
    const values = { sandbox: request.sandbox.label, place: originLabel(request.origin), username: request.username ?? `` };
    return request.username === undefined ? t(`app.requests.wants`, values) : t(`app.requests.wantsAs`, values);
};

const answer = async (request: PasswordRequest, how: KeyringNeedAnswer): Promise<void> => {
    if (waiting.value !== undefined) {
        return;
    }
    waiting.value = `${request.id}:${how}`;
    errors.delete(request.id);
    try {
        const value = typed.get(request.id);
        if (request.matches.length === 0 && how !== `deny`) {
            await port.answer(request.id, how, { value: value ?? `` });
        } else {
            const name = picked.get(request.id) ?? request.matches[0];
            await port.answer(request.id, how, name === undefined ? undefined : { name });
        }
        typed.delete(request.id);
        emit(`answered`);
    } catch (failure) {
        errors.set(request.id, messageOr(failure, t(`app.error.act`)));
    } finally {
        waiting.value = undefined;
    }
};

const onTyped = (id: string, event: Event): void => {
    if (event.target instanceof HTMLInputElement) {
        typed.set(id, event.target.value);
    }
};

// Each answer with its label, read in the reader's language as it changes.
const answers = computed<readonly { readonly how: KeyringNeedAnswer; readonly label: string }[]>(() => [
    { how: `once`, label: t(`app.requests.once`) },
    { how: `while-here`, label: t(`app.requests.whileHere`) },
    { how: `always`, label: t(`app.requests.always`) },
]);
</script>

<template>
    <section class="ui-softscroll flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pb-8 pr-1" :aria-label="t(`app.requests.title`)">
        <p v-if="requests.length === 0" class="px-2 py-6 text-xs text-muted">{{ t(`app.requests.empty`) }}</p>
        <article v-for="request in requests" :key="request.id" class="flex flex-col gap-3 rounded-xl border border-line-subtle bg-card p-4">
            <div class="flex items-start gap-3">
                <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-tint text-primary-fill" aria-hidden="true"><Icon name="robot" /></span>
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                    <h3 class="text-sm font-medium text-content">{{ headline(request) }}</h3>
                    <p class="text-xs text-muted">
                        {{ t(`app.requests.for`, { detail: request.detail }) }} · {{ timeAgo(request.at, { now }) }}<template v-if="request.computer">
                            · {{ t(`app.requests.onComputer`, { computer: request.computer }) }}</template
                        >
                    </p>
                </div>
            </div>

            <Notice v-if="errors.get(request.id)" tone="danger" size="sm" @dismiss="errors.delete(request.id)">{{ errors.get(request.id) }}</Notice>

            <fieldset v-if="request.matches.length > 1" class="flex flex-col gap-1">
                <legend class="mb-1 text-2xs text-subtle">{{ t(`app.requests.use`) }}</legend>
                <label v-for="name in request.matches" :key="name" class="flex cursor-pointer items-center gap-2 text-sm text-content">
                    <input
                        type="radio"
                        :name="`need-${request.id}`"
                        :value="name"
                        :checked="(picked.get(request.id) ?? request.matches[0]) === name"
                        @change="picked.set(request.id, name)"
                    />
                    <span>{{ titleOf(name) }}</span>
                    <span v-if="usernameOf(name)" class="text-xs text-muted">{{ usernameOf(name) }}</span>
                </label>
            </fieldset>
            <p v-else-if="request.matches.length === 1" class="text-xs text-muted">
                {{ t(`app.requests.use`) }} <span class="font-medium text-content">{{ titleOf(request.matches[0] ?? ``) }}</span>
                <template v-if="usernameOf(request.matches[0] ?? ``)"> · {{ usernameOf(request.matches[0] ?? ``) }}</template>
            </p>
            <div v-else-if="port.capabilities.manage" class="flex flex-col gap-1.5">
                <p class="text-xs text-muted">{{ t(`app.requests.noMatch`) }}</p>
                <input
                    type="password"
                    :class="ui.input(`font-mono`)"
                    :aria-label="t(`app.requests.typeOnce`)"
                    :placeholder="t(`app.requests.typeOnce`)"
                    autocomplete="off"
                    :value="typed.get(request.id) ?? ``"
                    @input="onTyped(request.id, $event)"
                />
            </div>

            <div v-if="port.capabilities.manage" class="flex flex-wrap items-center gap-2">
                <template v-if="request.matches.length > 0">
                    <Button
                        v-for="(choice, index) in answers"
                        :key="choice.how"
                        :tier="index === 0 ? undefined : `boring`"
                        size="small"
                        :label="choice.label"
                        :disabled="waiting !== undefined"
                        :loading="waiting === `${request.id}:${choice.how}`"
                        @click="answer(request, choice.how)"
                    />
                </template>
                <Button
                    v-else
                    size="small"
                    :label="t(`app.requests.saveAllow`)"
                    :disabled="waiting !== undefined || (typed.get(request.id) ?? ``) === ``"
                    :loading="waiting === `${request.id}:once`"
                    @click="answer(request, `once`)"
                />
                <Button
                    tier="quiet"
                    size="small"
                    :label="t(`app.requests.deny`)"
                    :disabled="waiting !== undefined"
                    :loading="waiting === `${request.id}:deny`"
                    @click="answer(request, `deny`)"
                />
                <span v-if="waiting?.startsWith(`${request.id}:`)" class="flex items-center gap-1.5 text-2xs text-info" role="status"><Icon name="spinner" spin />{{ t(`app.confirmHere`) }}</span>
            </div>
            <Button v-else-if="port.manageOnComputer" tier="boring" size="small" class="self-start" :label="t(`app.manageOnComputer`)" @click="port.manageOnComputer()" />
        </article>
    </section>
</template>
