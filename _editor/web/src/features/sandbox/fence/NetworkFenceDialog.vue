<!-- THE NETWORK FENCE OF ONE SANDBOX: what it may reach on the networks around the machine it runs on. The internet
     stays open either way; `Internet only` refuses the LAN, the machine itself, networks reached through a VPN and
     link-local metadata, except the exceptions listed. A failure of the state ic reports leads, then the switch and the
     drawing of what it means (FenceReach.vue), which stands in for the sentences that used to explain it. Everything
     below is about a fence that is on, so it shows only while the draft is: the ways around it, the exceptions, and the
     two places an exception is offered from, what the fence refused lately and what this sandbox's own cards dial.
     Exceptions held while it is off still show, so they are not hidden by a switch. Saving a change that only tightens
     sends it; one that loosens asks for the owner's passkey first (networkFence.ts, the Save button says so), and says
     what to do instead where that cannot happen here. -->
<script setup lang="ts">
import type {
    EgressAllow,
    EgressBlocked,
    EgressOwnerKeysRead,
    EgressPolicy,
    EgressProfile,
    EgressStatus,
} from "@intentic/sandbox-contract/schemas/egress";
import { Button, Code, Icon, Modal, Notice, Row, RowGroup, RowNote, SegmentedControl, timeAgo, ui } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId, watch } from "vue";
import { RouterLink } from "vue-router";
import {
    allows,
    blockedException,
    type ChangeTarget,
    EMPTY_EXCEPTION,
    type ExceptionForm,
    exceptionOf,
    exceptionWords,
    heldPolicy,
    icEgressCommand,
    loosens,
    samePolicy,
    withException,
    withoutException,
} from "../../../models/sandbox/devices/egressFlow";
import { accessPath } from "../../../models/sandbox/sandboxNav";
import FenceReach from "./FenceReach.vue";
import { readOwnerKeys, sendFence, signStanding } from "./networkFence";

const t = useT();

const { open, machine, hostId, target, status } = defineProps<{
    open: boolean;
    /** The machine it runs on, as the page names it. */
    machine: string;
    hostId: string;
    /** Where a signed change is carried out; `machineId` absent from an agent too old to say, which cannot sign. */
    target: ChangeTarget;
    /** What ic holds and enforces now; absent from an ic that has never fenced this sandbox. */
    status: EgressStatus | undefined;
}>();
const emit = defineEmits<{ close: []; saved: [message: string] }>();

const draft = ref<EgressPolicy>(heldPolicy(status));
const read = ref<EgressOwnerKeysRead | undefined>();
const form = ref<ExceptionForm | undefined>();
const problem = ref<string | undefined>();
const failure = ref<string | undefined>();
const saving = ref(false);
const uid = useId();

watch(
    () => open,
    (showing) => {
        if (!showing) {
            return;
        }
        draft.value = heldPolicy(status);
        form.value = undefined;
        problem.value = undefined;
        failure.value = undefined;
        // What signing would take, read as the dialog opens so the footer can say it before anything is pressed.
        readOwnerKeys().then(
            (answer) => (read.value = answer),
            () => (read.value = undefined),
        );
    },
    { immediate: true },
);

const held = computed(() => heldPolicy(status));
const changed = computed(() => !samePolicy(draft.value, held.value));
const needsProof = computed(() => changed.value && loosens(held.value, draft.value));
const standing = computed(() => signStanding(read.value));
const blocked = computed(() => [...(status?.blocked ?? [])].toSorted((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)).slice(0, 8));
// Only this sandbox's own row: the cards it names are this daemon's, and another sandbox's are not read here.
const suggested = computed(() => (read.value?.slug === target.slug ? read.value.suggestions : []));

const profile = computed<EgressProfile>({
    get: () => draft.value.profile,
    set: (value) => (draft.value = { ...draft.value, profile: value }),
});
const fenced = computed(() => profile.value === `internet-only`);
// Protocol names are the same in every language, and the catalog says them too, so the check reading this file can.
const PROTOCOLS = computed(() => [
    { value: `both`, label: t(`sandbox.networkFence.tcpUdp`) },
    { value: `tcp`, label: t(`sandbox.networkFence.tcp`) },
    { value: `udp`, label: t(`sandbox.networkFence.udp`) },
]);
const PROFILES = computed(() => [
    { label: t(`sandbox.networkFence.off`), value: `open` as const },
    { label: t(`sandbox.networkFence.internetOnly`), value: `internet-only` as const },
]);

// The state ic reports, as the one sentence each needs; nothing while the fence is simply in force or off.
const notes = computed(() => {
    const said: { readonly key: string; readonly tone: `warning` | `danger` | `info`; readonly text: string }[] = [];
    if (status?.state === `failed`) {
        said.push({
            key: `failed`,
            tone: `danger`,
            text: t(`sandbox.networkFence.failed`, { reason: status.reason ?? t(`sandbox.networkFence.noReason`) }),
        });
    } else if (status?.state === `pending`) {
        said.push({ key: `pending`, tone: `info`, text: t(`sandbox.networkFence.pending`) });
    } else if (status?.state === `unsupported`) {
        said.push({ key: `unsupported`, tone: `warning`, text: t(`sandbox.networkFence.unsupported`) });
    }
    return said;
});
// The ways around a fence, said once beneath the drawing and only while the draft puts one up: with it off there is
// nothing to step around.
const bypass = computed(() =>
    [
        status?.advisory === true ? t(`sandbox.networkFence.advisory`, { machine }) : undefined,
        status?.hostShell === true ? t(`sandbox.networkFence.hostShell`, { machine }) : undefined,
    ].filter((line) => line !== undefined),
);

const allow = (entry: EgressAllow): void => {
    draft.value = withException({ ...draft.value, profile: `internet-only` }, entry);
};
const blockedTitle = (entry: EgressBlocked): string => (entry.port === undefined ? entry.to : `${entry.to}:${entry.port}`);
const blockedWords = (entry: EgressBlocked): string =>
    [
        entry.protocol === `other` ? undefined : entry.protocol.toUpperCase(),
        t(`sandbox.networkFence.packets`, { count: entry.packets }, entry.packets),
        entry.lastSeenAt === undefined ? undefined : timeAgo(entry.lastSeenAt),
    ]
        .filter((part) => part !== undefined)
        .join(` · `);

const addException = (): void => {
    if (form.value === undefined) {
        return;
    }
    const parsed = exceptionOf(form.value);
    if (`problem` in parsed) {
        problem.value = parsed.problem;
        return;
    }
    draft.value = withException(draft.value, parsed.entry);
    form.value = undefined;
    problem.value = undefined;
};
const setForm = (field: keyof ExceptionForm, value: string): void => {
    if (form.value !== undefined) {
        form.value = { ...form.value, [field]: value };
    }
};

const signable = computed(() => standing.value === `ready` && target.machineId !== ``);
const blockedWhy = computed(() => {
    if (target.machineId === ``) {
        return t(`sandbox.networkFence.agentTooOld`);
    }
    return standing.value === `not-owner`
        ? t(`sandbox.networkFence.notOwner`)
        : standing.value === `no-webauthn`
          ? t(`sandbox.networkFence.noWebauthn`)
          : t(`sandbox.networkFence.noPasskey`);
});
const command = computed(() => icEgressCommand(target.slug, draft.value));

const save = async (): Promise<void> => {
    if (saving.value) {
        return;
    }
    saving.value = true;
    failure.value = undefined;
    try {
        emit(`saved`, await sendFence({ hostId, target }, status, draft.value));
    } catch (error) {
        failure.value = messageOr(error, t(`sandbox.networkFence.refused`));
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <Modal
        :open="open"
        size="md"
        :header="t(`sandbox.networkFence.title`)"
        @update:open="emit(`close`)"
    >
        <div class="flex flex-col gap-5">
            <Notice v-for="note in notes" :key="note.key" :tone="note.tone" size="sm">{{ note.text }}</Notice>

            <div class="flex flex-col gap-4">
                <SegmentedControl v-model="profile" :options="PROFILES" size="sm" class="self-start" />
                <FenceReach :fenced="fenced" :machine="machine" />
                <Notice v-if="fenced && bypass.length > 0" tone="warning" size="sm">
                    <span v-for="(line, index) in bypass" :key="line" class="block" :class="index > 0 && `mt-1`">{{ line }}</span>
                </Notice>
            </div>

            <RowGroup v-if="fenced || draft.allow.length > 0" :label="t(`sandbox.networkFence.exceptions`)">
                <template #actions>
                    <Button
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.networkFence.add`)"
                        :disabled="form !== undefined"
                        @click="form = { ...EMPTY_EXCEPTION }"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <!-- The new exception, at the top of the list where it will stand. -->
                <RowNote v-if="form" variant="block">
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center gap-2">
                            <input
                                :id="`${uid}-to`"
                                :value="form.to"
                                :placeholder="t(`sandbox.networkFence.destinationPlaceholder`)"
                                :aria-label="t(`sandbox.networkFence.destination`)"
                                :class="ui.input({ size: `sm` }, `min-w-40 flex-1 font-mono`)"
                                @input="setForm(`to`, ($event.target as HTMLInputElement).value)"
                                @keydown.enter="addException"
                            />
                            <input
                                :value="form.ports"
                                :placeholder="t(`sandbox.networkFence.portsPlaceholder`)"
                                :aria-label="t(`sandbox.networkFence.portsLabel`)"
                                :class="ui.input({ size: `sm` }, `w-32 font-mono`)"
                                @input="setForm(`ports`, ($event.target as HTMLInputElement).value)"
                                @keydown.enter="addException"
                            />
                            <select
                                :value="form.protocol"
                                :aria-label="t(`sandbox.networkFence.protocol`)"
                                :class="ui.input({ size: `sm` }, `w-28`)"
                                @change="setForm(`protocol`, ($event.target as HTMLSelectElement).value)"
                            >
                                <option v-for="choice in PROTOCOLS" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
                            </select>
                        </div>
                        <div class="flex flex-wrap items-center gap-2">
                            <input
                                :value="form.note"
                                :placeholder="t(`sandbox.networkFence.notePlaceholder`)"
                                :aria-label="t(`sandbox.networkFence.note`)"
                                :class="ui.input({ size: `sm` }, `min-w-40 flex-1`)"
                                @input="setForm(`note`, ($event.target as HTMLInputElement).value)"
                                @keydown.enter="addException"
                            />
                            <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="((form = undefined), (problem = undefined))" />
                            <Button size="small" tier="boring" :label="t(`sandbox.networkFence.addIt`)" @click="addException" />
                        </div>
                        <p v-if="problem" class="text-2xs text-warning">{{ problem }}</p>
                    </div>
                </RowNote>
                <Row v-for="(entry, index) in draft.allow" :key="`${entry.to}:${index}`" :description="exceptionWords(entry)">
                    <template #title
                        ><span class="font-mono">{{ entry.to }}</span></template
                    >
                    <template #control>
                        <Button
                            size="small"
                            tier="quiet"
                            tone="danger"
                            :label="t(`ui.action.remove`)"
                            :aria-label="t(`sandbox.networkFence.removeException`, { to: entry.to })"
                            @click="draft = withoutException(draft, index)"
                        />
                    </template>
                </Row>
                <RowNote v-if="draft.allow.length === 0 && !form">{{ t(`sandbox.networkFence.noExceptions`) }}</RowNote>
                <RowNote v-else-if="!fenced && draft.allow.length > 0">{{ t(`sandbox.networkFence.keptWhileOff`) }}</RowNote>
                <RowNote v-if="fenced && (status?.neverAllow.length ?? 0) > 0">{{
                    t(`sandbox.networkFence.neverAllow`, { machine, list: status?.neverAllow.join(`, `) })
                }}</RowNote>
            </RowGroup>

            <RowGroup v-if="fenced && blocked.length > 0" :label="t(`sandbox.networkFence.recentlyBlocked`)">
                <Row v-for="entry in blocked" :key="`${entry.to}:${entry.port ?? ``}:${entry.protocol}`" :description="blockedWords(entry)">
                    <template #title
                        ><span class="font-mono">{{ blockedTitle(entry) }}</span></template
                    >
                    <template #control>
                        <span v-if="allows(draft, blockedException(entry))" class="text-2xs text-subtle">{{
                            t(`sandbox.networkFence.allowed`)
                        }}</span>
                        <Button v-else size="small" tier="quiet" :label="t(`sandbox.networkFence.allow`)" @click="allow(blockedException(entry))" />
                    </template>
                </Row>
            </RowGroup>

            <RowGroup v-if="fenced && suggested.length > 0" :label="t(`sandbox.networkFence.suggested`)">
                <Row v-for="entry in suggested" :key="`${entry.from}:${entry.to}`" :description="exceptionWords(entry)">
                    <template #title
                        ><span class="font-mono">{{ entry.to }}</span></template
                    >
                    <template #control>
                        <span v-if="allows(draft, entry)" class="text-2xs text-subtle">{{ t(`sandbox.networkFence.allowed`) }}</span>
                        <Button v-else size="small" tier="quiet" :label="t(`sandbox.networkFence.allow`)" @click="allow(entry)" />
                    </template>
                </Row>
            </RowGroup>

            <!-- A loosening this browser cannot sign: why, and the two ways it can still be made. -->
            <div v-if="needsProof && !signable" class="flex flex-col gap-2">
                <Notice tone="warning" size="sm">{{ blockedWhy }}</Notice>
                <ol class="flex list-decimal flex-col gap-2 pl-5 text-xs text-muted">
                    <li v-if="standing === `no-passkey`">
                        <RouterLink :to="accessPath(`sign-in`)" class="text-link hover:underline">{{
                            t(`sandbox.networkFence.addPasskey`, { slug: target.slug })
                        }}</RouterLink>
                    </li>
                    <li class="flex flex-col gap-1.5">
                        <span>{{ t(`sandbox.networkFence.onMachine`, { machine }) }}</span>
                        <Code :code="command" lang="bash" copyable wrap />
                    </li>
                </ol>
            </div>

            <Notice v-if="failure" tone="danger" size="sm">{{ failure }}</Notice>
        </div>

        <template #footer>
            <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="emit(`close`)" />
            <Button
                tier="accent"
                :label="needsProof ? t(`sandbox.networkFence.signAndSave`) : t(`ui.action.save`)"
                :disabled="!changed || (needsProof && !signable)"
                :loading="saving"
                @click="void save()"
            >
                <template v-if="needsProof" #icon><Icon name="key" /></template>
            </Button>
        </template>
    </Modal>
</template>
