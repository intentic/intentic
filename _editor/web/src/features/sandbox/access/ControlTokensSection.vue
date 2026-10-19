<script setup lang="ts">
import {
    CONTROL_SCOPE_REACH,
    type ControlScope,
    type ControlTokenMint,
    type ControlTokenSummary,
} from "@intentic/sandbox-contract/policy/control-scopes";
import { Button, Code, CopyButton, Notice, Picker, type PickerOption, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { formatDate, timeAgo } from "@intentic/ui/format";
import { computed, ref } from "vue";
import { useMintedTokens } from "../../../workbench/operations/useMintedTokens";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useRole } from "../../../client/sandbox/useRole";
import { useT } from "@intentic/ui/i18n";

// Program credential minted here by the owner or a maintainer: every scope, every token against this sandbox, and the
// paste-ready snippets for a shell, CI and an editor. Shown once — the daemon keeps only the hash.

const t = useT();

type Expiry = `30` | `90` | `365` | `never`;

// Which rungs a token can hold, and which paste-ready forms exist for them; the ACP editor slice is one
// `editor`-scoped token, minted here like any other rather than on a screen of its own.
const SCOPES: readonly ControlScope[] = [`read`, `drive`, `land`, `editor`];
const SNIPPETS: readonly (`curl` | `github` | `acp`)[] = [`curl`, `github`, `acp`];
const DEFAULT_EXPIRY: Expiry = `90`;

interface MintRequest {
    readonly label: string;
    readonly scope: ControlScope;
    // Epoch ms; undefined mints a token that lives until revoked.
    readonly expiresAt: number | undefined;
}

const { daemonUrl, active } = useSandbox();
// Unfiltered by scope: hiding tokens minted elsewhere would let a leaked one stay live unnoticed.
const { tokens, minted, minting, notice, mint, forgetMinted, revoke } = useMintedTokens({
    list: async () => (await sandboxRaw(`GET /system/control/tokens`)).tokens,
    mint: async ({ label, scope, expiresAt }: MintRequest) => {
        const named = label.trim();
        const input: ControlTokenMint = { scope };
        if (named !== ``) {
            input.label = named;
        }
        if (expiresAt !== undefined) {
            input.expiresAt = expiresAt;
        }
        const { token } = await sandboxRaw(`POST /system/control/tokens`, { input });
        return { token, label: named === `` ? scope : named, scope };
    },
    revoke: async (id) => {
        await sandboxRaw(`DELETE /system/control/tokens/{id}`, { params: { id } });
        return undefined;
    },
    owner: () => active.value?.id,
    key: `access/control-tokens/mint`,
});

// Maintainer and up, the floor of all three token routes (the daemon's operating gate, `ownerDenied`), which is not the
// owner alone: a maintainer holds the owner's operating authority, and only the member roster stays the owner's.
const { canShip } = useRole();

const SCOPE_ICONS: Record<ControlScope, PickerOption[`icon`]> = { editor: `code`, read: `eye`, drive: `play`, land: `check-circle` };

// Short picker hints, same voice as the member-role picker; CONTROL_SCOPE_REACH stays long for OpenAPI/site.
// Built when read, so the hints follow a language switch.
const scopeHints = (): Record<ControlScope, string> => ({
    editor: t(`sandbox.controlTokensSection.hintEditor`),
    read: t(`sandbox.controlTokensSection.hintRead`),
    drive: t(`sandbox.controlTokensSection.hintDrive`),
    land: t(`sandbox.controlTokensSection.hintLand`),
});

// Picker rows are the model: label is the lowercase scope (capitalized via CSS), hint is the teaching sentence.
const scopeOptions = computed<readonly PickerOption<ControlScope>[]>(() => {
    const hints = scopeHints();
    return CONTROL_SCOPE_REACH.filter((entry) => SCOPES.includes(entry.scope)).map((entry) => ({
        value: entry.scope,
        label: entry.scope,
        icon: SCOPE_ICONS[entry.scope],
        hint: hints[entry.scope],
    }));
});

const EXPIRY_OPTIONS = computed((): readonly PickerOption<Expiry>[] => [
    { value: `30`, label: t(`sandbox.words.n30Days`) },
    { value: `90`, label: t(`sandbox.words.n90Days`) },
    { value: `365`, label: t(`sandbox.controlTokensSection.n1Year`) },
    {
        value: `never`,
        label: t(`sandbox.words.never`),
        hint: t(`sandbox.controlTokensSection.livesUntilRevokedRight`),
    },
]);

const label = ref(``);
const scope = ref<ControlScope | undefined>(SCOPES[0]);
const expiry = ref<Expiry | undefined>(DEFAULT_EXPIRY);

// What the picked rung can do, said under the form: the picker shows it only while open, and a token is minted closed.
const scopeHint = computed(() => scopeOptions.value.find((option) => option.value === scope.value)?.hint ?? ``);

const expiresAtOf = (choice: Expiry | undefined): number | undefined =>
    choice === undefined || choice === `never` ? undefined : Date.now() + Number(choice) * 24 * 60 * 60 * 1000;

// The form is asked for (the group's New token), not standing open over the list: most visits here are to read or revoke
// what is already minted. It closes on a mint, whose value then stands in its place until put away.
const creating = ref(false);
const startCreate = (): void => {
    forgetMinted();
    creating.value = true;
};

const submit = async (): Promise<void> => {
    if (scope.value === undefined || minting.value) {
        return;
    }
    await mint({ label: label.value, scope: scope.value, expiresAt: expiresAtOf(expiry.value) });
    if (minted.value !== undefined) {
        label.value = ``;
        creating.value = false;
    }
};

// The paste-ready forms

const origin = computed(() => daemonUrl.value ?? `https://sandbox-….intentic.dev`);

const curlSnippet = computed(() =>
    minted.value === undefined
        ? ``
        : [
              `export INTENTIC_TOKEN=${minted.value.token}`,
              // allow(contract-paths): a command the owner pastes into a shell, which no typed client reaches
              `curl "${origin.value}/git/root/status" \\`,
              `  -H "x-intentic-control: $INTENTIC_TOKEN"`,
          ].join(`\n`),
);

// Runs via the Marketplace action (intentic/gate-action); token goes in the repo's secret store once. URL is the
// sandbox's own address, not a secret.
const githubSnippet = computed(() =>
    [
        `- name: Run the intentic agent`,
        `  uses: intentic/gate-action@v1`,
        `  with:`,
        `    url: ${origin.value}`,
        `    token: \${{ secrets.INTENTIC_TOKEN }}`,
        `    prompt: "Review this change: \${{ github.event.pull_request.html_url || github.sha }}"`,
    ].join(`\n`),
);

const acpSnippet = computed(() =>
    minted.value === undefined
        ? ``
        : JSON.stringify(
              {
                  agent_servers: {
                      intentic: {
                          type: `custom`,
                          command: `npx`,
                          args: [`@intentic/acp-bridge`],
                          env: { INTENTIC_SANDBOX_URL: origin.value, INTENTIC_CONTROL_TOKEN: minted.value.token },
                      },
                  },
              },
              undefined,
              2,
          ),
);

// Which forms fit the rung just minted: an editor token has one home; a driving token is what CI holds.
const shownSnippets = computed(() => {
    const rung = minted.value?.scope;
    return SNIPPETS.filter((kind) => (kind === `acp` ? rung === `editor` : kind === `github` ? rung === `drive` || rung === `land` : true));
});

// The roster

const now = ref(Date.now());

const expired = (token: ControlTokenSummary): boolean => token.expiresAt !== undefined && token.expiresAt <= now.value;

// One sentence under the label, not facts in the meta column, which doesn't shrink and would squeeze the row at a
// phone's width. Only "expired" earns the meta column, as a single coloured word.
const lifetime = (token: ControlTokenSummary): string => {
    if (expired(token)) {
        return t(`sandbox.controlTokensSection.expiredOn`, { date: formatDate(token.expiresAt ?? 0) });
    }
    return token.expiresAt === undefined
        ? t(`sandbox.controlTokensSection.neverExpires`)
        : t(`sandbox.controlTokensSection.expiresOn`, { date: formatDate(token.expiresAt) });
};

const lastUsed = (token: ControlTokenSummary): string =>
    token.lastUsedAt === undefined
        ? t(`sandbox.controlTokensSection.neverUsed`)
        : t(`sandbox.controlTokensSection.usedAgo`, { ago: timeAgo(token.lastUsedAt, { now: now.value, days: true }) });

const describe = (token: ControlTokenSummary): string =>
    [
        `${token.scope} · ${
            token.createdBy === undefined
                ? t(`sandbox.controlTokensSection.mintedOn`, { date: formatDate(token.createdAt) })
                : t(`sandbox.controlTokensSection.mintedOnBy`, { date: formatDate(token.createdAt), who: token.createdBy })
        }`,
        lifetime(token),
        lastUsed(token),
    ].join(` · `);
</script>

<template>
    <RowGroup v-if="canShip" data-setting="access-api-tokens" :label="t(`shared.apiTokens`)">
        <template #actions>
            <Button v-if="!creating" :label="t(`sandbox.controlTokensSection.newToken`)" size="small" tier="boring" @click="startCreate">
                <template #icon><Icon name="plus" /></template>
            </Button>
        </template>

        <!-- What was asked for sits first, under the press that asked: the form, then the value it minted, shown once. -->
        <RowNote v-if="creating || notice || minted" variant="block">
            <div class="flex flex-col gap-3">
                <Notice v-if="notice" :of="notice" />
                <form v-if="creating" class="flex flex-col gap-2" @submit.prevent="submit">
                    <!-- Token rows wrap to the column, including when chat is docked. -->
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            v-model="label"
                            type="text"
                            autocomplete="off"
                            autofocus
                            :placeholder="t(`sandbox.controlTokensSection.labelEGNightly`)"
                            :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)"
                        />
                        <div class="flex min-w-0 flex-wrap items-center gap-2">
                            <Picker
                                v-if="scopeOptions.length > 1"
                                v-model="scope"
                                :options="scopeOptions"
                                variant="input"
                                :aria-label="t(`sandbox.controlTokensSection.tokenScope`)"
                                :header="t(`sandbox.controlTokensSection.scope`)"
                                label-class="capitalize"
                                class="ui-field-sm w-32"
                            />
                            <Picker
                                v-model="expiry"
                                :options="EXPIRY_OPTIONS"
                                variant="input"
                                :aria-label="t(`sandbox.controlTokensSection.tokenExpiry`)"
                                :header="t(`sandbox.controlTokensSection.expires`)"
                                class="ui-field-sm w-32"
                            />
                        </div>
                    </div>
                    <!-- The cost of the rung, in the picker's own words, under the form where the choice is made. -->
                    <div class="flex flex-wrap items-center justify-end gap-2">
                        <p class="mr-auto min-w-0 text-2xs text-subtle">{{ scopeHint }}</p>
                        <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" :disabled="minting" @click="creating = false" />
                        <Button
                            type="submit"
                            :label="t(`sandbox.controlTokensSection.mintToken`)"
                            size="small"
                            :loading="minting"
                            :disabled="minting || scope === undefined"
                            class="shrink-0"
                        >
                            <template #icon><Icon name="key" /></template>
                        </Button>
                    </div>
                </form>

                <div v-if="minted" class="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                    <!-- Kept until put away: it is never shown again, so only the reader knows it is safely stored. -->
                    <div class="flex items-start gap-2">
                        <p class="flex-1 text-2xs text-subtle">{{ t(`sandbox.controlTokensSection.shownOnceCopyNow`) }}</p>
                        <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)" @click="forgetMinted">
                            {{ t(`ui.action.done`) }}
                        </button>
                    </div>
                    <div class="flex items-center gap-2">
                        <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ minted.token }}</code>
                        <CopyButton :text="minted.token" :label="t(`ui.action.copy`)" />
                    </div>
                    <Code
                        v-if="shownSnippets.includes(`curl`)"
                        :code="curlSnippet"
                        lang="bash"
                        :label="t(`sandbox.controlTokensSection.shellAnywhere`)"
                        :wrap="true"
                    />
                    <Code
                        v-if="shownSnippets.includes(`github`)"
                        :code="githubSnippet"
                        lang="yaml"
                        :label="t(`sandbox.controlTokensSection.githubActionsTokenGoes`)"
                    />
                    <Code
                        v-if="shownSnippets.includes(`acp`)"
                        :code="acpSnippet"
                        lang="json"
                        :label="t(`sandbox.controlTokensSection.zedSettingsJsonJetbrains`)"
                    />
                </div>
            </div>
        </RowNote>

        <Row v-for="token in tokens" :key="token.id" icon="key" :title="token.label" :description="describe(token)">
            <!-- Same pill the member roster uses for the same word, so "expired" doesn't get two spellings. -->
            <template v-if="expired(token)" #meta>
                <StatusBadge variant="danger" :label="t(`sandbox.controlTokensSection.expired`)" size="xs" />
            </template>
            <template #control>
                <Button :label="t(`ui.action.revoke`)" size="small" tier="quiet" tone="danger" @click="revoke(token.id)" />
            </template>
        </Row>
        <!-- No token, and none being made: what one is for, so the empty card is not a blank. -->
        <RowNote v-if="tokens.length === 0 && !creating && !minted" variant="empty">{{ t(`sandbox.controlTokensSection.empty`) }}</RowNote>
    </RowGroup>
</template>
