<script setup lang="ts">
import type { ApiToken } from "@intentic/api-contract";
import { Button, Code, CopyButton, Notice, Row, RowGroup, RowNote, ui } from "@intentic/ui";
import { formatDate, timeAgo } from "@intentic/ui/format";
import { ref } from "vue";
import { useApiTokens } from "./useApiTokens";
import { useT } from "@intentic/ui/i18n";

// ACCOUNT tokens: what acts for this person outside a browser. One scope exists — `provision`, which a sandbox holds
// on its Sandbox fleet capability so an agent in it can create sandboxes here. Shown once; the platform keeps only a
// digest.

const t = useT();

const { tokens, minted, minting, notice, mint, revoke } = useApiTokens();

const label = ref(``);

const submit = async (): Promise<void> => {
    if (minting.value) {
        return;
    }
    await mint(label.value, `provision`);
    label.value = ``;
};

const now = ref(Date.now());

// One sentence under the label rather than facts in the meta column, which does not shrink and would squeeze the row
// at a phone's width. "Never used" is the fact worth seeing: it is how a forgotten token is spotted.
const describe = (token: ApiToken): string =>
    [
        `${token.scope} · minted ${formatDate(Date.parse(token.createdAt))}`,
        token.lastUsedAt === undefined ? `never used` : `used ${timeAgo(Date.parse(token.lastUsedAt), { now: now.value, days: true })}`,
    ].join(` · `);

// What the owner does with it: paste it into the sandbox's own Sandbox fleet card. Not a curl line — nothing about
// this token is meant to be driven by hand.
const pasteSnippet = `Capabilities → Sandbox fleet → Provisioning token`;
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`settings.settingsTokens.apiTokens`)" :count="tokens.length === 0 ? undefined : tokens.length">
            <Row v-for="token in tokens" :key="token.id" icon="key" :title="token.label" :description="describe(token)">
                <template #control>
                    <Button :label="t(`settings.settingsTokens.revoke`)" size="small" severity="danger" :text="true" @click="revoke(token.id)" />
                </template>
            </Row>

            <RowNote variant="block">
                <div class="flex flex-col gap-3">
                    <p class="text-2xs text-subtle">{{ t(`settings.settingsTokens.whatProvisioningTokensAre`) }}</p>
                    <Notice v-if="notice" :of="notice" />
                    <form class="flex flex-wrap items-center gap-2" @submit.prevent="submit">
                        <input
                            v-model="label"
                            type="text"
                            autocomplete="off"
                            :placeholder="t(`settings.settingsTokens.labelEGStorefrontSandbox`)"
                            :class="ui.inputSm(`min-w-48 flex-1`)"
                        />
                        <Button
                            type="submit"
                            :label="t(`settings.settingsTokens.mintToken`)"
                            size="small"
                            :loading="minting"
                            :disabled="minting"
                            class="shrink-0"
                        >
                            <template #icon><Icon name="key" /></template>
                        </Button>
                    </form>

                    <div v-if="minted" class="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                        <p class="text-2xs text-subtle">{{ t(`settings.settingsTokens.shownOnceCopyNow`) }}</p>
                        <div class="flex items-center gap-2">
                            <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ minted.token }}</code>
                            <CopyButton :text="minted.token" :label="t(`ui.action.copy`)" />
                        </div>
                        <Code :code="pasteSnippet" lang="text" :label="t(`settings.settingsTokens.whereItGoes`)" :wrap="true" />
                    </div>
                </div>
            </RowNote>
        </RowGroup>
    </div>
</template>
