<!-- A capability need's own answer: the connection's form inside the card, a new credential, or a setting change. -->
<script setup lang="ts">
import { type CapabilityCatalogEntry, capabilityEffects, type CapabilityEffect } from "@intentic/capability-catalog";
import type { CapabilityNeed, Need } from "@intentic/sandbox-contract";
import { Notice, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, reactive, ref } from "vue";
import CapabilityFieldRow from "../capabilities/connect/CapabilityFieldRow.vue";
import { guideParts, guideTokenUrl } from "../capabilities/connect/credentialGuide";
import SecretField from "../capabilities/connect/SecretField.vue";
import { useCapabilities } from "../capabilities/connect/useCapabilities";
import { buildConfig, cleanName, fieldError, formComplete, inlineField, nameError, seedValues, shownFields } from "../capabilities/model/form";
import { generatesKey } from "../capabilities/model/sshKey";
import SshKeyField from "../capabilities/ssh/SshKeyField.vue";
import { catalogEntries, suggestName } from "../capabilities/model/tiles";
import ChatDecisionButton from "../chat/transcript/cards/ChatDecisionButton.vue";
import { useExtensions } from "../extensions/useExtensions";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: CapabilityNeed }>();

const { capabilities, add } = useCapabilities();
const { enabled } = useExtensions();
const needs = useNeeds();
const entry = computed<CapabilityCatalogEntry | undefined>(() =>
    catalogEntries(enabled.value, capabilities.value).find((candidate) => candidate.id === props.subject.entry),
);
const instance = computed(() => capabilities.value.find((capability) => capability.id === props.subject.instance));

// The kinds whose form alone finishes the setup: anything that pairs a device, signs a browser in or installs code
// goes through its own page, where those flows live, with the need's settings carried there.
const INLINE_KINDS = new Set([`cli`, `mcp`, `ssh`, `endpoint`, `fleet`]);
const inline = computed(() => entry.value !== undefined && INLINE_KINDS.has(entry.value.kind));

// A connection's name: the site's when the entry holds one per site, else the one the Capabilities page would pick (a
// singleton's own id, which it has no box to change).
const suggestedName = (): string => {
    const host = props.subject.target?.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ``).replace(/[/:?#].*$/, ``) ?? ``;
    if (host !== `` && entry.value?.singleton !== true) {
        return cleanName(`${props.subject.entry}-${host.split(`.`)[0] ?? ``}`);
    }
    return entry.value === undefined ? cleanName(props.subject.entry) : suggestName(entry.value, capabilities.value);
};
const name = ref(suggestedName());
const values = reactive<Record<string, string>>(entry.value === undefined ? {} : seedValues(entry.value, undefined, props.subject.prefill ?? {}));
const fields = computed(() => (entry.value === undefined ? [] : shownFields(entry.value, values)));
const complete = computed(() => entry.value !== undefined && formComplete(entry.value, values, name.value));

// What saving it does beyond storing a credential, said before the press: a rebuild, a restart, a privilege.
const consequences = computed<string[]>(() => {
    if (entry.value === undefined) {
        return [];
    }
    const config = props.subject.mode === `change` ? { ...(instance.value?.config ?? {}), ...(props.subject.changes ?? {}) } : values;
    return capabilityEffects({ kind: entry.value.kind, config }).flatMap((effect: CapabilityEffect) => {
        switch (effect.kind) {
            case `image`:
                return [t(`needs.capability.effectRebuild`)];
            case `restart`:
                return [t(`needs.capability.effectRestart`, { process: effect.process })];
            case `gpu`:
                return [t(`needs.capability.effectGpu`)];
            case `runtime`:
                return effect.level === `privileged` ? [t(`needs.capability.effectPrivileged`)] : [];
            default:
                return [];
        }
    });
});

const { busy, notice, run } = useAsyncAction();

// Saved through the same route as the Capabilities page; the need is met when the daemon sees it come live.
const connect = async (): Promise<void> => {
    const tile = entry.value;
    if (tile === undefined || !complete.value) {
        return;
    }
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.need.id, answer: { kind: `accept` } });
        await add({ id: name.value, kind: tile.kind, config: buildConfig(tile, values) });
    }, t(`needs.capability.couldNotConnect`));
};

// A change applied the way an edit is: every stored credential kept by its marker, only the named settings moved.
const change = async (): Promise<void> => {
    const tile = entry.value;
    const connection = instance.value;
    if (tile === undefined || connection === undefined) {
        return;
    }
    await run(async () => {
        const answers = seedValues(tile, connection.config, props.subject.changes ?? {});
        await add({ id: connection.id, kind: tile.kind, config: buildConfig(tile, answers, new Set(connection.secrets)) });
    }, t(`needs.capability.couldNotApply`));
};

// The person's word that the new credential is in; the daemon checks the connection answers before it takes it.
const fixed = async (): Promise<void> => {
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.need.id, answer: { kind: `apply` } });
    }, t(`needs.capability.notWorkingYet`));
};

const setupAt = computed(() => ({ path: `/capabilities/${props.subject.entry}`, query: { need: props.need.id } }));

// Where the credential comes from, folded: the provider's token page first, then the catalog's own steps.
const tokenUrl = computed(() => (entry.value === undefined ? undefined : guideTokenUrl(entry.value, values)));
const guideSteps = computed<readonly string[]>(() => entry.value?.guide?.steps ?? []);
const settingOf = (key: string): string => entry.value?.fields.find((field) => field.key === key)?.label ?? key;
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <span v-if="subject.reason" class="text-2xs text-muted">{{ subject.reason }}</span>
        <ul v-if="consequences.length > 0" class="flex flex-col gap-0.5 text-2xs text-warning">
            <li v-for="line in consequences" :key="line" class="flex items-center gap-1.5"><Icon name="exclamation-triangle" />{{ line }}</li>
        </ul>

        <!-- A new connection whose form finishes it: filled in with everything the agent could know, credential empty. -->
        <form v-if="subject.mode === `connect` && inline && entry" class="flex flex-col gap-3" @submit.prevent="connect">
            <details v-if="tokenUrl || guideSteps.length > 0" class="text-2xs text-muted">
                <summary class="cursor-pointer text-xs text-link">{{ t(`needs.capability.howToGet`) }}</summary>
                <div class="mt-1.5 flex flex-col gap-1.5">
                    <a v-if="tokenUrl" :href="tokenUrl" target="_blank" rel="noreferrer" class="inline-flex items-center gap-1 text-link hover:underline">
                        {{ entry.guide?.linkLabel ?? t(`needs.capability.createToken`) }} <Icon name="external-link" />
                    </a>
                    <ol v-if="guideSteps.length > 0" class="flex list-decimal flex-col gap-1 pl-4 leading-relaxed break-words marker:text-subtle">
                        <li v-for="(step, index) in guideSteps" :key="index">
                            <span v-for="(part, partIndex) in guideParts(step)" :key="partIndex" :class="part.literal ? `font-medium text-content` : ``">{{ part.text }}</span>
                        </li>
                    </ol>
                </div>
            </details>
            <!-- A singleton has no name to choose: its one connection is the entry itself. -->
            <label v-if="entry.singleton !== true" class="ui-field">
                <span class="ui-field-label">{{ t(`needs.capability.name`) }}</span>
                <input v-model="name" :class="ui.input('w-full font-mono')" autocapitalize="off" spellcheck="false" />
                <span v-if="nameError(name)" class="text-2xs text-warning">{{ nameError(name) }}</span>
            </label>
            <template v-for="field in fields" :key="field.key">
                <!-- A key the sandbox makes: only its public half and the line that authorizes it, never a box to paste into. -->
                <SshKeyField v-if="generatesKey(entry, field, values)" :field="field" :values="values" />
                <SecretField v-else-if="field.secret" v-model="values[field.key]" :secret-key="field.label" :multiline="field.multiline === true" collect no-hint />
                <CapabilityFieldRow v-else :field="field" :values="values" :inline="inlineField(field)" :alarm="values[field.key] ? fieldError(field, values[field.key]) : undefined" />
            </template>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="primary" icon="bolt" type="submit" :disabled="!complete || busy">{{ t(`needs.capability.connect`, { name: subject.name }) }}</ChatDecisionButton>
                <ChatDecisionButton tone="secondary" icon="external-link" :to="setupAt">{{ t(`needs.capability.fullForm`) }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </form>

        <!-- One whose setup lives on its page (a device to pair, a browser to sign in): carried there with the need. -->
        <div v-else-if="subject.mode === `connect`" class="flex flex-wrap items-center gap-2">
            <span class="text-xs text-content/85">{{ t(`needs.capability.setUpOnPage`) }}</span>
            <ChatDecisionButton tone="primary" icon="bolt" :to="setupAt">{{ t(`needs.capability.setUp`, { name: subject.name }) }}</ChatDecisionButton>
            <slot name="decline" />
        </div>

        <!-- A connection whose credential stopped working: only the credential, in place. -->
        <div v-else-if="subject.mode === `reconnect` && instance" class="flex flex-col gap-2">
            <span class="text-xs text-content/85">{{ t(`needs.capability.newCredential`, { id: instance.id }) }}</span>
            <SecretField v-if="instance.secrets.length > 0" :secret-key="instance.secrets[0] ?? ``" :capability-id="instance.id" no-hint @saved="fixed" />
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="secondary" icon="check" :disabled="busy" @click="fixed">{{ t(`needs.capability.itWorks`) }}</ChatDecisionButton>
                <ChatDecisionButton tone="secondary" icon="external-link" :to="{ path: `/capabilities/${subject.entry}`, query: { edit: instance.id } }">{{
                    t(`needs.capability.editConnection`)
                }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </div>

        <!-- A setting on a connected one: each change as it would land, applied in one press. -->
        <div v-else-if="subject.mode === `change` && instance" class="flex flex-col gap-2">
            <ul class="flex flex-col gap-0.5">
                <li v-for="(value, key) in subject.changes" :key="key" class="flex items-center gap-2 text-xs">
                    <span class="text-content/85">{{ settingOf(String(key)) }}</span>
                    <span class="font-mono text-2xs text-subtle">{{ instance.config[key] ?? `—` }}</span>
                    <Icon name="arrow-right" class="text-2xs text-subtle" />
                    <span class="font-mono text-2xs text-content">{{ value }}</span>
                </li>
            </ul>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="change">{{ t(`needs.capability.apply`) }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </div>

        <Notice v-if="notice" :of="notice" />
    </div>
</template>
