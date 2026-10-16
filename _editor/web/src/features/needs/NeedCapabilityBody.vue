<!-- A capability need's own answer: the connection's form inside the card (a linked sandbox paired in it), a new credential, a setting change, or a removal. -->
<script setup lang="ts">
import { type CapabilityCatalogEntry, capabilityEffects, type CapabilityEffect } from "@intentic/capability-catalog";
import type { CapabilityNeed, Need } from "@intentic/sandbox-contract/schemas/needs";
import { type NoticeModel, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, reactive, ref } from "vue";
import CapabilityFieldRow from "../../components/CapabilityFieldRow.vue";
import LinkPairing from "../../components/LinkPairing.vue";
import type { PairedLink } from "../../components/linkPairing";
import { guideParts, guideTokenUrl } from "../../models/capabilities/credentialGuide";
import SecretField from "../../parts/capabilities/SecretField.vue";
import { useCapabilities } from "../../models/capabilities/useCapabilities";
import { buildConfig, cleanName, fieldError, formComplete, inlineField, nameError, seedValues, shownFields } from "../../models/capabilities/form";
import { generatesKey, sshKeyScope } from "../../models/capabilities/sshKey";
import SshKeyField from "../../parts/capabilities/SshKeyField.vue";
import { catalogEntries, suggestName } from "../../models/capabilities/tiles";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useExtensions } from "../../models/extensions/useExtensions";
import { dismissOperation, operationsUnder } from "../../workbench/operations/operations";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: CapabilityNeed }>();

const { capabilities, add, remove } = useCapabilities();
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
    const config = props.subject.mode === `change` ? { ...instance.value?.config, ...props.subject.changes } : values;
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

// The answer is the need's, not this card's (needAnswer.ts): an install can take minutes, and after the accept the need
// reads `working` on the daemon, so a refused add has to outlive the card or the need stays working with nobody told
// why; and a change pressed again over one still applying is refused by the daemon.
const { busy, notice, lines, answer } = useNeedAnswer(() => props.need);
// The install's own words while it runs, as the Capabilities page shows them in its terminal.
const heard =
    (report: { line: (text: string) => void }) =>
    (frame: Record<string, unknown>): void => {
        const message = frame[`message`];
        if (typeof message === `string` && frame[`kind`] !== `error`) {
            report.line(message);
        }
    };
const lastLine = computed(() => lines.value.at(-1));

// Saved through the same route as the Capabilities page; the need is met when the daemon sees it come live.
const connect = async (): Promise<void> => {
    const tile = entry.value;
    if (tile === undefined || !complete.value) {
        return;
    }
    // Taken at the press: the card may be gone by the time the accept lands.
    const id = props.need.id;
    const input = { id: name.value, kind: tile.kind, config: buildConfig(tile, values) };
    await answer({
        what: t(`needs.capability.connecting`, { name: props.subject.name }),
        tag: `connect`,
        failed: t(`needs.capability.couldNotConnect`),
        task: async (report) => {
            await needs.answer.mutateAsync({ id, answer: { kind: `accept` } });
            await add(input, heard(report));
            // A key made on this card (the same one the full form would show) is spent once the connection holds it.
            for (const made of operationsUnder(sshKeyScope(tile.id))) {
                dismissOperation(made.key);
            }
        },
    });
};

// A change applied the way an edit is: every stored credential kept by its marker, only the named settings moved.
const change = async (): Promise<void> => {
    const tile = entry.value;
    const connection = instance.value;
    if (tile === undefined || connection === undefined) {
        return;
    }
    const id = props.need.id;
    const answers = seedValues(tile, connection.config, props.subject.changes ?? {});
    const input = { id: connection.id, kind: tile.kind, config: buildConfig(tile, answers, new Set(connection.secrets)) };
    await answer({
        what: t(`needs.capability.applying`, { id: connection.id }),
        tag: `change`,
        failed: t(`needs.capability.couldNotApply`),
        task: async (report) => {
            await add(input, heard(report));
            // Settled now, not on the daemon's next poll: the card closes with this press instead of offering it again.
            // The poll may have closed it first, which is the same outcome.
            if (needs.byId(id)?.status !== `met`) {
                await needs.answer.mutateAsync({ id, answer: { kind: `apply` } });
            }
        },
    });
};

// A linked sandbox, paired in the card: this editor mints the link over there under the reader's own session, and the
// press that paired it also saves the card, since nothing is left to fill in.
const linking = computed(() => props.subject.mode === `connect` && entry.value?.kind === `link`);
const pairingNotice = ref<NoticeModel | null>(null);
const paired = async (link: PairedLink): Promise<void> => {
    name.value = link.id;
    values[`url`] = link.url;
    values[`token`] = link.token;
    values[`name`] = link.name;
    await connect();
};

// A removal, done the way the Capabilities page's Remove does it; the daemon meets the need once the connection is gone.
const removeIt = async (): Promise<void> => {
    const connection = instance.value;
    if (connection === undefined) {
        return;
    }
    const id = props.need.id;
    await answer({
        what: t(`needs.capability.removing`, { id: connection.id }),
        tag: `remove`,
        failed: t(`needs.capability.couldNotRemove`),
        task: async () => {
            await remove.mutateAsync(connection.id);
            if (needs.byId(id)?.status !== `met`) {
                await needs.answer.mutateAsync({ id, answer: { kind: `apply` } });
            }
        },
    });
};

// The person's word that the new credential is in; the daemon checks the connection answers before it takes it.
const fixed = async (): Promise<void> => {
    const id = props.need.id;
    await answer({
        tag: `fixed`,
        failed: t(`needs.capability.notWorkingYet`),
        task: () => needs.answer.mutateAsync({ id, answer: { kind: `apply` } }),
    });
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

        <!-- Another of the reader's sandboxes, paired here: the one the agent named is chosen already. -->
        <div v-if="linking" class="flex flex-col gap-2">
            <LinkPairing :prefer="subject.target" @pick="paired" @notice="pairingNotice = $event" />
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="secondary" icon="external-link" :to="setupAt">{{ t(`needs.capability.fullForm`) }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
            <Notice v-if="pairingNotice" :of="pairingNotice" />
        </div>

        <!-- A new connection whose form finishes it: filled in with everything the agent could know, credential empty. -->
        <form v-else-if="subject.mode === `connect` && inline && entry" class="flex flex-col gap-3" @submit.prevent="connect">
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
                <SshKeyField v-if="generatesKey(entry, field, values)" :field="field" :values="values" :entry="entry.id" />
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

        <!-- A connection to take away: what goes with it, removed in one press. -->
        <div v-else-if="subject.mode === `remove` && instance" class="flex flex-col gap-2">
            <span class="text-xs text-content/85">{{ t(`needs.capability.removeWhat`, { id: instance.id, name: subject.name }) }}</span>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="primary" icon="trash" :disabled="busy" @click="removeIt">{{ t(`needs.capability.remove`, { id: instance.id }) }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </div>

        <p v-if="busy && lastLine" class="truncate font-mono text-2xs text-subtle" v-tooltip.top.overflow="lastLine">{{ lastLine }}</p>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
