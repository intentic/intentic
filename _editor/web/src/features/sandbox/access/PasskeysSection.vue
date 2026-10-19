<script setup lang="ts">
import type { PasskeySummary } from "@intentic/sandbox-contract/schemas/system";
import { Button, Code, Notice, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { formatDate, timeAgo } from "@intentic/ui/format";
import { computed, ref } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { usePasskeys } from "./usePasskeys";
import { useT } from "@intentic/ui/i18n";

// Passkeys on the Access tab: the sandbox is the relying party, so a passkey here opens THIS sandbox and no other.
// Everyone manages their own; the owner also sees members' (to reset one who is locked out) and holds the rule that
// a passkey is the only proof that opens the sandbox, with the recovery codes that keep that rule from locking the
// owner out. Codes are shown once; the daemon keeps only their hashes.

const t = useT();

const { user } = useAuth();
const { active } = useSandbox();
const { list, unread, codes, forgetCodes, busy, notice, supported, add, remove, setRequired, regenerateCodes } = usePasskeys();

const isOwner = computed(() => active.value?.role === `owner`);
const label = ref(``);

const mine = (passkey: PasskeySummary): boolean => passkey.email.toLowerCase() === (user.value?.email ?? ``).toLowerCase();
const ownCount = computed(() => list.value.passkeys.filter(mine).length);

const now = ref(Date.now());

// One sentence under the label, in the token rows' voice: when it was added, when it last answered, which editor host
// it is bound to (a passkey made on one origin answers from no other).
const describe = (passkey: PasskeySummary): string =>
    [
        t(`sandbox.passkeysSection.addedOn`, { date: formatDate(passkey.createdAt) }),
        passkey.lastUsedAt === undefined
            ? t(`sandbox.passkeysSection.neverUsed`)
            : t(`sandbox.passkeysSection.usedAgo`, { ago: timeAgo(passkey.lastUsedAt, { now: now.value, days: true }) }),
        passkey.rpId,
    ].join(` · `);

// The form stands open while the reader has no passkey of their own, as adding one is what they came for; once they have
// one it is asked for with the group's Add a passkey, and closes again on the next one added.
const asked = ref(false);
const formOpen = computed(() => asked.value || ownCount.value === 0);

const submit = async (): Promise<void> => {
    if (busy.value || !supported) {
        return;
    }
    const before = ownCount.value;
    await add(label.value);
    if (ownCount.value > before) {
        label.value = ``;
        asked.value = false;
    }
};

// Switching on needs a passkey of the owner's own to open the door with; the button says so rather than 409ing.
const canRequire = computed(() => list.value.required || ownCount.value > 0);

const codesText = computed(() => (codes.value ?? []).join(`\n`));
</script>

<template>
    <RowGroup
        data-setting="access-passkeys"
        :label="t(`sandbox.passkeysSection.passkeys`)"
        :count="list.passkeys.length === 0 ? undefined : list.passkeys.length"
    >
        <template #actions>
            <Button v-if="!formOpen" :label="t(`sandbox.words.addPasskey`)" size="small" tier="boring" :disabled="!supported" @click="asked = true">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <RowNote v-if="formOpen || unread || notice || !supported" variant="block">
            <div class="flex flex-col gap-3">
                <Notice v-if="unread" :of="unread" />
                <Notice v-if="notice" :of="notice" />
                <form v-if="formOpen" class="flex flex-wrap items-center gap-2" @submit.prevent="submit">
                    <input
                        v-model="label"
                        type="text"
                        autocomplete="off"
                        :placeholder="t(`sandbox.words.nameEGWork`)"
                        :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)"
                    />
                    <Button v-if="asked" :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="busy" @click="asked = false" />
                    <Button
                        type="submit"
                        :label="t(`sandbox.words.addPasskey`)"
                        size="small"
                        :loading="busy"
                        :disabled="busy || !supported"
                        class="shrink-0"
                    >
                        <template #icon><Icon name="key" /></template>
                    </Button>
                </form>
                <span v-if="!supported" class="text-2xs text-subtle">{{ t(`sandbox.passkeysSection.browserCantCreatePasskeys`) }}</span>
            </div>
        </RowNote>

        <Row v-for="passkey in list.passkeys" :key="passkey.id" icon="key" :title="passkey.label" :description="describe(passkey)">
            <template #meta>
                <!-- Another member's passkey, in the owner's list: named so a reset removes the right one. -->
                <StatusBadge v-if="!mine(passkey)" variant="neutral" :label="passkey.email" size="xs" />
                <StatusBadge v-if="passkey.backedUp" variant="info" :label="t(`sandbox.passkeysSection.synced`)" size="xs" />
            </template>
            <template #control>
                <Button :label="t(`ui.action.remove`)" size="small" tier="quiet" tone="danger" @click="remove(passkey.id)" />
            </template>
        </Row>

        <!-- Unread, the rule could be on or off: drawn from the empty list it would read "Off" about a sandbox that may require it. -->
        <template v-if="isOwner && unread === undefined">
            <Row icon="shield" :title="t(`sandbox.passkeysSection.requirePasskeyToOpen`)">
                <template #meta>
                    <StatusBadge
                        :variant="list.required ? `success` : `neutral`"
                        :label="list.required ? t(`sandbox.passkeysSection.required`) : t(`sandbox.passkeysSection.optional`)"
                        size="xs"
                    />
                </template>
                <template #control>
                    <Button
                        :label="list.required ? t(`sandbox.passkeysSection.stopRequiring`) : t(`sandbox.passkeysSection.requirePasskey`)"
                        size="small"
                        :tier="list.required ? `boring` : `accent`"
                        :loading="busy"
                        :disabled="busy || !canRequire"
                        @click="setRequired(!list.required)"
                    />
                </template>
            </Row>
            <Row
                v-if="list.required"
                icon="key"
                :title="t(`sandbox.passkeysSection.recoveryCodes`)"
                :description="t(`sandbox.passkeysSection.unusedOneCodePlus`, { remaining: list.recovery?.remaining ?? 0 })"
            >
                <template #control>
                    <Button :label="t(`sandbox.passkeysSection.newCodes`)" size="small" tier="quiet" :disabled="busy" @click="regenerateCodes" />
                </template>
                <template v-if="codes" #below>
                    <div class="flex flex-col gap-2">
                        <span class="text-2xs text-subtle">{{ t(`sandbox.passkeysSection.saveNowTheyShown`) }}</span>
                        <Code :code="codesText" :label="t(`sandbox.passkeysSection.recoveryCodes`)" />
                        <!-- Kept until put away: they are never shown again, so only the owner knows they are saved. -->
                        <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `self-end`)" @click="forgetCodes">
                            {{ t(`ui.action.done`) }}
                        </button>
                    </div>
                </template>
            </Row>
        </template>
    </RowGroup>
</template>
