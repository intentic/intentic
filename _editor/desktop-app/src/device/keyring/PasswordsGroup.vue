<script setup lang="ts">
import { KEYRING_NAME_RE, type KeyringShareMode } from "@intentic/sandbox-contract";
import { Button, Notice, Row, RowGroup, RowNote, SegmentedControl, ui } from "@intentic/ui";
import { formatTime } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onMounted, ref } from "vue";
import type { KeyringEntry } from "../../desktop";
import { type PasswordsAct, usePasswords } from "./passwords";

// THE PASSWORDS GROUP of This device's machine agent: the keyring on this computer, where a password can be kept instead
// of in a sandbox, typed into a window here or handed to a sandbox for one use without the sandbox's agent ever holding
// it. Not set up, it offers the setup, which asks for a recovery passphrase twice. Set up, it says whether it is locked,
// lists what it keeps and with which sandboxes each is shared, and adds, shares and removes. Every change makes the
// keyring ask the person at this computer, so the group says "Confirm on this computer" while the prompt is up. A value
// typed here goes to the app and from there to the agent's standard input, and is out of this page at the press.

const t = useT();

const { windows = false, links = [] } = defineProps<{
    /** Hardened mode and Windows Hello are Windows' own. */
    windows?: boolean;
    /** The sandboxes linked to this computer, offered as where a new password is shared. */
    links?: readonly { readonly sandboxUrl: string; readonly id: string }[];
}>();

const passwords = usePasswords();
const { status, noAgent, entries, reading, tooOld, readError, waiting, error, setUp, locked } = passwords;
onMounted(() => void passwords.load());

const busy = computed(() => waiting.value !== undefined);

// ---- setup ----
const settingUp = ref(false);
const passphrase = ref(``);
const again = ref(``);
const hello = ref(true);
// Long enough that guessing it is not the easy way in; the keyring may ask for more, and says so when it does.
const PASSPHRASE_MIN = 8;
const passphraseProblem = computed<string | undefined>(() => {
    if (passphrase.value === ``) {
        return undefined;
    }
    if (passphrase.value.length < PASSPHRASE_MIN) {
        return t(`desktop.passwords.passphraseShort`, { min: PASSPHRASE_MIN });
    }
    return again.value !== `` && again.value !== passphrase.value ? t(`desktop.passwords.passphrasesDiffer`) : undefined;
});
const canSetUp = computed(() => passphrase.value.length >= PASSPHRASE_MIN && again.value === passphrase.value && !busy.value);
const runSetup = async (): Promise<void> => {
    if (!canSetUp.value) {
        return;
    }
    // Out of the page at the press, whether the keyring takes it or not.
    const given = passphrase.value;
    passphrase.value = ``;
    again.value = ``;
    if (await passwords.setup(given, windows && hello.value)) {
        settingUp.value = false;
    }
};

// ---- the lock ----
const lockLine = computed(() => {
    const state = status.value?.state;
    if (state === undefined || state.locked) {
        return t(`desktop.passwords.locked`);
    }
    return state.unlockedUntil === undefined ? t(`desktop.passwords.unlocked`) : t(`desktop.passwords.unlockedUntil`, { time: formatTime(state.unlockedUntil) });
});
const lockNote = computed(() => {
    const ways = status.value?.state?.unlock ?? [];
    const how = ways.includes(`hello`) ? t(`desktop.passwords.unlockHello`) : t(`desktop.passwords.unlockPassphrase`);
    const pending = status.value?.state?.pendingInbox ?? 0;
    return pending > 0 ? `${how} ${t(`desktop.passwords.pendingInbox`, { count: pending })}` : how;
});

// ---- the entries ----
// How a share reads in an entry's line: lower case, inside a sentence, where the form's choices are labels.
const MODE_WORDS = computed<Readonly<Record<KeyringShareMode, string>>>(() => ({
    "each-use": t(`desktop.passwords.shareEachUse`),
    "while-here": t(`desktop.passwords.shareWhileHere`),
    copy: t(`desktop.passwords.shareCopy`),
}));
// A sandbox by its host, which is how a person knows it; the link id when that is all there is.
const sandboxName = (sandbox: string): string => {
    try {
        return new URL(sandbox).host;
    } catch {
        return sandbox;
    }
};
const rulesOf = (entry: KeyringEntry): string => {
    const into = [...entry.programs, ...entry.packages];
    return [
        entry.kind === `password` ? t(`desktop.passwords.kindPassword`) : t(`desktop.passwords.kindText`),
        into.length > 0 ? t(`desktop.passwords.into`, { programs: into.join(`, `) }) : t(`desktop.passwords.intoAsks`),
        entry.hosts.length > 0 ? t(`desktop.passwords.sites`, { hosts: entry.hosts.join(`, `) }) : undefined,
        entry.anyField ? t(`desktop.passwords.anyFieldShort`) : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(` · `);
};
const sharesOf = (entry: KeyringEntry): string =>
    entry.shares.length === 0
        ? t(`desktop.passwords.notShared`)
        : entry.shares.map((share) => t(`desktop.passwords.sharedWith`, { sandbox: sandboxName(share.sandbox), mode: MODE_WORDS.value[share.mode] })).join(` · `);

const confirmingRemove = ref<string | undefined>(undefined);
const remove = async (name: string): Promise<void> => {
    confirmingRemove.value = undefined;
    await passwords.remove(name);
};

// ---- adding one ----
const adding = ref(false);
const name = ref(``);
const value = ref(``);
const showValue = ref(false);
const kind = ref<`password` | `text`>(`password`);
const programsTyped = ref(``);
const hostsTyped = ref(``);
const anyField = ref(false);
const shareTo = ref(``);
const shareMode = ref<KeyringShareMode>(`each-use`);
const kindOptions = computed(() => [
    { label: t(`desktop.passwords.kindPassword`), value: `password` as const },
    { label: t(`desktop.passwords.kindText`), value: `text` as const },
]);
const modeOptions = computed(() => [
    { label: t(`desktop.passwords.modeEachUse`), value: `each-use` as const },
    { label: t(`desktop.passwords.modeWhileHere`), value: `while-here` as const },
    { label: t(`desktop.passwords.modeCopy`), value: `copy` as const },
]);
// Comma or line separated, as a list is pasted.
const listOf = (typed: string): string[] => typed.split(/[,\n]/u).map((part) => part.trim()).filter((part) => part !== ``);
const nameValid = computed(() => KEYRING_NAME_RE.test(name.value));
const nameTaken = computed(() => entries.value.some((entry) => entry.name === name.value));
const nameProblem = computed<string | undefined>(() => {
    if (name.value === ``) {
        return undefined;
    }
    if (!nameValid.value) {
        return t(`desktop.passwords.nameRule`);
    }
    return nameTaken.value ? t(`desktop.passwords.nameTaken`, { name: name.value }) : undefined;
});
const canAdd = computed(() => nameValid.value && !nameTaken.value && value.value !== `` && !busy.value);
const resetDraft = (): void => {
    name.value = ``;
    value.value = ``;
    showValue.value = false;
    kind.value = `password`;
    programsTyped.value = ``;
    hostsTyped.value = ``;
    anyField.value = false;
    shareTo.value = ``;
    shareMode.value = `each-use`;
};
const cancelAdd = (): void => {
    adding.value = false;
    resetDraft();
};
const add = async (): Promise<void> => {
    if (!canAdd.value) {
        return;
    }
    const given = value.value;
    // Out of the page at the press, whether the keyring takes it or not.
    value.value = ``;
    showValue.value = false;
    const sandbox = shareTo.value.trim();
    const added = await passwords.add({
        entry: {
            name: name.value,
            kind: kind.value,
            programs: listOf(programsTyped.value),
            packages: [],
            hosts: listOf(hostsTyped.value),
            anyField: anyField.value,
        },
        value: given,
        share: sandbox === `` ? undefined : { sandbox, mode: shareMode.value },
    });
    if (added) {
        adding.value = false;
        resetDraft();
    }
};

// ---- the rest of it ----
const askpassOn = computed(() => status.value?.askpass.installed === true);
const hardened = computed(() => status.value?.hardened === true);

const WAITING_WORDS = computed<Readonly<Record<PasswordsAct, string>>>(() => ({
    setup: t(`desktop.passwords.waitingSetup`),
    add: t(`desktop.passwords.waitingAdd`),
    remove: t(`desktop.passwords.waitingRemove`),
    share: t(`desktop.passwords.waitingShare`),
    unlock: t(`desktop.passwords.waitingUnlock`),
    lock: t(`desktop.passwords.waitingLock`),
    askpass: t(`desktop.passwords.waitingAskpass`),
    harden: t(`desktop.passwords.waitingHarden`),
}));
</script>

<template>
    <RowGroup v-if="!noAgent" :label="t(`desktop.passwords.heading`)" data-passwords>
        <!-- While a prompt is up on this computer, first: where to look, since it can open behind other windows. -->
        <RowNote v-if="waiting" icon="shield" role="status">
            <span class="font-medium text-content">{{ t(`desktop.passwords.confirmHere`) }}</span>
            {{ WAITING_WORDS[waiting] }}
        </RowNote>
        <RowNote v-if="reading" icon="spinner">{{ t(`desktop.passwords.reading`) }}</RowNote>

        <!-- An agent older than its keyring: what brings one, rather than a setup that would be refused. -->
        <RowNote v-else-if="tooOld" icon="info-circle">{{ tooOld }}</RowNote>

        <RowNote v-else-if="readError && status === undefined" icon="exclamation-circle" tone="warning">
            {{ t(`desktop.passwords.couldNotRead`) }} <span class="font-mono text-2xs">{{ readError }}</span>
        </RowNote>

        <!-- NOT SET UP: what it is for, and the one step to it. -->
        <template v-else-if="!setUp">
            <Row icon="lock" :title="t(`desktop.passwords.notSetUpTitle`)" :description="t(`desktop.passwords.notSetUpLead`)">
                <template #control>
                    <Button v-if="!settingUp" size="small" :label="t(`desktop.passwords.setUp`)" :disabled="busy" @click="settingUp = true" />
                </template>
            </Row>
            <RowNote v-if="settingUp" variant="block">
                <form class="flex max-w-read-sm flex-col gap-2" @submit.prevent="runSetup">
                    <p class="text-xs text-muted">{{ t(`desktop.passwords.passphraseLead`) }}</p>
                    <input
                        v-model="passphrase"
                        type="password"
                        autocomplete="new-password"
                        :placeholder="t(`desktop.passwords.passphrase`)"
                        :aria-label="t(`desktop.passwords.passphrase`)"
                        :class="ui.input(`w-full`)"
                    />
                    <input
                        v-model="again"
                        type="password"
                        autocomplete="new-password"
                        :placeholder="t(`desktop.passwords.passphraseAgain`)"
                        :aria-label="t(`desktop.passwords.passphraseAgain`)"
                        :class="ui.input(`w-full`)"
                    />
                    <span v-if="passphraseProblem" class="text-2xs text-warning">{{ passphraseProblem }}</span>
                    <label v-if="windows" class="flex items-center justify-between gap-2 text-xs text-content">
                        <span>{{ t(`desktop.passwords.useHello`) }}</span>
                        <ToggleSwitch v-model="hello" :aria-label="t(`desktop.passwords.useHello`)" />
                    </label>
                    <div class="flex flex-wrap items-center gap-2">
                        <Button size="small" :label="t(`desktop.passwords.setUp`)" :disabled="!canSetUp" :loading="waiting === `setup`" @click="runSetup" />
                        <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" :disabled="busy" @click="settingUp = false" />
                    </div>
                </form>
            </RowNote>
        </template>

        <!-- SET UP: the lock, what it keeps, and the ways it answers. -->
        <template v-else>
            <Row :icon="locked ? `lock` : `unlock`" :title="lockLine" :description="lockNote">
                <template #control>
                    <Button
                        v-if="locked"
                        size="small"
                        :label="t(`desktop.passwords.unlock`)"
                        :disabled="busy"
                        :loading="waiting === `unlock`"
                        @click="passwords.unlock()"
                    />
                    <Button
                        v-else
                        size="small"
                        tier="boring"
                        :label="t(`desktop.passwords.lock`)"
                        :disabled="busy"
                        :loading="waiting === `lock`"
                        @click="passwords.lock()"
                    />
                </template>
            </Row>

            <Row v-for="entry of entries" :key="entry.name" icon="key" :description="`${rulesOf(entry)} — ${sharesOf(entry)}`">
                <template #title><span class="font-mono">{{ entry.name }}</span></template>
                <template #control>
                    <template v-if="confirmingRemove === entry.name">
                        <Button
                            size="small"
                            tone="danger"
                            :label="t(`desktop.passwords.confirmRemove`)"
                            :disabled="busy"
                            :aria-label="t(`desktop.passwords.confirmRemoveOf`, { name: entry.name })"
                            @click="remove(entry.name)"
                        />
                        <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" @click="confirmingRemove = undefined" />
                    </template>
                    <button
                        v-else
                        type="button"
                        :class="ui.iconButton({ tone: `subtle` })"
                        :disabled="busy"
                        :aria-label="t(`desktop.passwords.removeOf`, { name: entry.name })"
                        v-tooltip.top="t(`ui.action.remove`)"
                        @click="confirmingRemove = entry.name"
                    >
                        <Icon name="trash" class="text-xs" />
                    </button>
                </template>
            </Row>
            <RowNote v-if="entries.length === 0 && !adding">{{ t(`desktop.passwords.none`) }}</RowNote>

            <RowNote v-if="!adding" variant="action" :label="t(`desktop.passwords.add`)" :disabled="busy" @click="adding = true" />
            <RowNote v-else variant="block">
                <form class="flex max-w-read flex-col gap-2" data-add-password @submit.prevent="add">
                    <input
                        v-model="name"
                        type="text"
                        autocapitalize="off"
                        spellcheck="false"
                        :placeholder="t(`desktop.passwords.name`)"
                        :aria-label="t(`desktop.passwords.name`)"
                        :class="ui.input(`w-full font-mono`)"
                    />
                    <span v-if="nameProblem" class="text-2xs text-warning">{{ nameProblem }}</span>
                    <div class="flex min-w-0 items-center gap-1">
                        <input
                            v-model="value"
                            :type="showValue ? `text` : `password`"
                            autocomplete="off"
                            spellcheck="false"
                            data-value
                            :placeholder="t(`desktop.passwords.value`)"
                            :aria-label="t(`desktop.passwords.value`)"
                            :class="ui.input(`min-w-0 flex-1 font-mono`)"
                        />
                        <button
                            type="button"
                            :class="ui.iconButton({ tone: `subtle` })"
                            :aria-label="showValue ? t(`desktop.passwords.hideValue`) : t(`desktop.passwords.showValue`)"
                            @click="showValue = !showValue"
                        >
                            <Icon :name="showValue ? `eye-slash` : `eye`" class="text-xs" />
                        </button>
                    </div>
                    <SegmentedControl v-model="kind" :options="kindOptions" size="xs" />
                    <input
                        v-model="programsTyped"
                        type="text"
                        spellcheck="false"
                        :placeholder="t(`desktop.passwords.programsPlaceholder`)"
                        :aria-label="t(`desktop.passwords.programs`)"
                        :class="ui.input(`w-full font-mono`)"
                    />
                    <input
                        v-model="hostsTyped"
                        type="text"
                        spellcheck="false"
                        :placeholder="t(`desktop.passwords.hostsPlaceholder`)"
                        :aria-label="t(`desktop.passwords.hosts`)"
                        :class="ui.input(`w-full font-mono`)"
                    />
                    <label class="flex items-center justify-between gap-2 text-xs text-content">
                        <span class="flex min-w-0 flex-col">
                            <span>{{ t(`desktop.passwords.anyField`) }}</span>
                            <span class="text-2xs text-subtle">{{ t(`desktop.passwords.anyFieldNote`) }}</span>
                        </span>
                        <ToggleSwitch v-model="anyField" :aria-label="t(`desktop.passwords.anyField`)" />
                    </label>

                    <!-- Where it goes straight away, if anywhere: one of the sandboxes linked to this computer, or another by its address. -->
                    <p class="pt-1 text-2xs font-medium uppercase tracking-wide text-subtle">{{ t(`desktop.passwords.shareHeading`) }}</p>
                    <div v-if="links.length > 0" class="flex flex-wrap gap-1">
                        <button
                            v-for="link of links"
                            :key="link.id"
                            type="button"
                            :class="ui.chip({ on: shareTo === link.sandboxUrl }, `py-1 px-2 text-2xs`)"
                            :aria-pressed="shareTo === link.sandboxUrl"
                            @click="shareTo = shareTo === link.sandboxUrl ? `` : link.sandboxUrl"
                        >
                            {{ sandboxName(link.sandboxUrl) }}
                        </button>
                    </div>
                    <input
                        v-model="shareTo"
                        type="text"
                        spellcheck="false"
                        :placeholder="t(`desktop.passwords.sandboxPlaceholder`)"
                        :aria-label="t(`desktop.passwords.sandbox`)"
                        :class="ui.input(`w-full font-mono`)"
                    />
                    <template v-if="shareTo.trim() !== ``">
                        <SegmentedControl v-model="shareMode" :options="modeOptions" size="xs" wrap />
                        <span class="text-2xs text-subtle">{{
                            shareMode === `each-use`
                                ? t(`desktop.passwords.modeEachUseExplained`)
                                : shareMode === `while-here`
                                  ? t(`desktop.passwords.modeWhileHereExplained`)
                                  : t(`desktop.passwords.modeCopyExplained`)
                        }}</span>
                    </template>

                    <div class="flex flex-wrap items-center gap-2 pt-1">
                        <Button size="small" :label="t(`desktop.passwords.addIt`)" :disabled="!canAdd" :loading="waiting === `add`" @click="add" />
                        <Button size="small" tier="quiet" :label="t(`ui.action.cancel`)" :disabled="busy" @click="cancelAdd" />
                    </div>
                </form>
            </RowNote>

            <!-- ssh, sudo and git asking the keyring for their passwords: each one still asks the person here. -->
            <Row icon="terminal" :title="t(`desktop.passwords.askpassTitle`)" :description="t(`desktop.passwords.askpassNote`)">
                <template #control>
                    <ToggleSwitch
                        :model-value="askpassOn"
                        :disabled="busy"
                        :aria-label="t(`desktop.passwords.askpassTitle`)"
                        @update:model-value="(on: boolean) => void passwords.askpass(on)"
                    />
                </template>
            </Row>

            <Row
                v-if="windows"
                icon="shield"
                :title="t(`desktop.passwords.hardenTitle`)"
                :description="hardened ? t(`desktop.passwords.hardenedNote`) : t(`desktop.passwords.hardenNote`)"
            >
                <template v-if="!hardened" #control>
                    <Button
                        size="small"
                        tier="boring"
                        :label="t(`desktop.passwords.harden`)"
                        :disabled="busy"
                        :loading="waiting === `harden`"
                        @click="passwords.harden()"
                    />
                </template>
            </Row>
        </template>

        <RowNote v-if="error" variant="block">
            <Notice tone="danger" class="text-2xs" :dismiss-label="t(`ui.action.dismiss`)" @dismiss="passwords.dismissError()">{{ error }}</Notice>
        </RowNote>
    </RowGroup>
</template>
