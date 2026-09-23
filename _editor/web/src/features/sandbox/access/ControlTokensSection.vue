<script setup lang="ts">
import { CONTROL_SCOPE_REACH, type ControlScope } from "@intentic/sandbox-contract";
import { Button, Code, CopyButton, Notice, Picker, type PickerOption, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { formatDate, timeAgo } from "@intentic/ui/format";
import { computed, ref } from "vue";
import { useMintedTokens } from "../../../lib/useMintedTokens";
import { jsonBody } from "../client/jsonBody";
import { sandboxJson } from "../client/sandboxClient";
import { useSandbox } from "../client/useSandbox";
import { useT } from "@intentic/ui/i18n";

// Program credential minted here by the owner: every scope, every token against this sandbox, and the
// paste-ready snippets for a shell, CI and an editor. Shown once — the daemon keeps only the hash.

const t = useT();

type Expiry = `30` | `90` | `365` | `never`;

// Which rungs a token can hold, and which paste-ready forms exist for them; the ACP editor slice is one
// `editor`-scoped token, minted here like any other rather than on a screen of its own.
const SCOPES: readonly ControlScope[] = [`read`, `drive`, `land`, `editor`];
const SNIPPETS: readonly (`curl` | `github` | `acp`)[] = [`curl`, `github`, `acp`];
const DEFAULT_EXPIRY: Expiry = `90`;

interface ControlToken {
    readonly id: string;
    readonly label: string;
    readonly scope: ControlScope;
    readonly createdAt: number;
    readonly createdBy?: string;
    readonly expiresAt?: number;
    readonly lastUsedAt?: number;
}

interface MintRequest {
    readonly label: string;
    readonly scope: ControlScope;
    // Epoch ms; undefined mints a token that lives until revoked.
    readonly expiresAt: number | undefined;
}

const TOKENS = `/system/control/tokens`;

const { daemonUrl, active } = useSandbox();
// Unfiltered by scope: hiding tokens minted elsewhere would let a leaked one stay live unnoticed.
const { tokens, minted, minting, notice, mint, revoke } = useMintedTokens({
    list: async () => (await sandboxJson<{ tokens?: ControlToken[] }>(TOKENS)).tokens ?? [],
    mint: async ({ label, scope, expiresAt }: MintRequest) => {
        const named = label.trim();
        const { token } = await sandboxJson<{ token: string }>(
            TOKENS,
            jsonBody(`POST`, { scope, ...(named === `` ? {} : { label: named }), ...(expiresAt === undefined ? {} : { expiresAt }) }),
        );
        return { token, label: named === `` ? scope : named, scope };
    },
    revoke: async (id) => {
        await sandboxJson(`${TOKENS}/${encodeURIComponent(id)}`, { method: `DELETE` });
        return undefined;
    },
    owner: () => active.value?.id,
});

const isOwner = computed(() => active.value?.role === `owner`);

const SCOPE_ICONS: Record<ControlScope, PickerOption[`icon`]> = { editor: `code`, read: `eye`, drive: `play`, land: `check-circle` };

// Short picker hints, same voice as the member-role picker; CONTROL_SCOPE_REACH stays long for OpenAPI/site.
const SCOPE_HINTS: Record<ControlScope, string> = {
    editor: `Can run one conversation: turns, cards, transcripts. Can't see the fleet or land work.`,
    read: `Can watch everything a viewer sees. Can't change anything.`,
    drive: `Can drive agents and steer turns. Can't land or purge worktrees.`,
    land: `Can land and purge conversation worktrees. The broadest credential a program holds.`,
};

// Picker rows are the model: label is the lowercase scope (capitalized via CSS), hint is the teaching sentence.
const scopeOptions = computed<readonly PickerOption<ControlScope>[]>(() =>
    CONTROL_SCOPE_REACH.filter((entry) => SCOPES.includes(entry.scope)).map((entry) => ({
        value: entry.scope,
        label: entry.scope,
        icon: SCOPE_ICONS[entry.scope],
        hint: SCOPE_HINTS[entry.scope],
    })),
);

const EXPIRY_OPTIONS = computed((): readonly PickerOption<Expiry>[] => [
    { value: `30`, label: t(`shared.n30Days`) },
    { value: `90`, label: t(`shared.n90Days`) },
    { value: `365`, label: t(`sandbox.controlTokensSection.n1Year`) },
    {
        value: `never`,
        label: t(`shared.never`),
        hint: t(`sandbox.controlTokensSection.livesUntilRevokedRight`),
    },
]);

const label = ref(``);
const scope = ref<ControlScope | undefined>(SCOPES[0]);
const expiry = ref<Expiry | undefined>(DEFAULT_EXPIRY);

const expiresAtOf = (choice: Expiry | undefined): number | undefined =>
    choice === undefined || choice === `never` ? undefined : Date.now() + Number(choice) * 24 * 60 * 60 * 1000;

const submit = async (): Promise<void> => {
    if (scope.value === undefined || minting.value) {
        return;
    }
    await mint({ label: label.value, scope: scope.value, expiresAt: expiresAtOf(expiry.value) });
    label.value = ``;
};

// The paste-ready forms

const origin = computed(() => daemonUrl.value ?? `https://sandbox-….intentic.dev`);

const curlSnippet = computed(() =>
    minted.value === undefined
        ? ``
        : [
              `export INTENTIC_TOKEN=${minted.value.token}`,
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

const expired = (token: ControlToken): boolean => token.expiresAt !== undefined && token.expiresAt <= now.value;

// One sentence under the label, not facts in the meta column, which doesn't shrink and would squeeze the row at a
// phone's width. Only "expired" earns the meta column, as a single coloured word.
const lifetime = (token: ControlToken): string => {
    if (expired(token)) {
        return `expired ${formatDate(token.expiresAt ?? 0)}`;
    }
    return token.expiresAt === undefined ? `never expires` : `expires ${formatDate(token.expiresAt)}`;
};

const lastUsed = (token: ControlToken): string =>
    token.lastUsedAt === undefined ? `never used` : `used ${timeAgo(token.lastUsedAt, { now: now.value, days: true })}`;

const describe = (token: ControlToken): string =>
    [
        `${token.scope} · minted ${formatDate(token.createdAt)}${token.createdBy === undefined ? `` : ` by ${token.createdBy}`}`,
        lifetime(token),
        lastUsed(token),
    ].join(` · `);
</script>

<template>
    <RowGroup v-if="isOwner" :label="t(`shared.apiTokens`)" :count="tokens.length === 0 ? undefined : tokens.length">
        <Row v-for="token in tokens" :key="token.id" icon="key" :title="token.label" :description="describe(token)">
            <!-- Same pill the member roster uses for the same word, so "expired" doesn't get two spellings. -->
            <template v-if="expired(token)" #meta>
                <StatusBadge variant="danger" :label="t(`sandbox.controlTokensSection.expired`)" size="xs" />
            </template>
            <template #control>
                <Button :label="t(`shared.revoke`)" size="small" severity="danger" :text="true" @click="revoke(token.id)" />
            </template>
        </Row>

        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <Notice v-if="notice" :of="notice" />
                <form class="flex flex-col gap-2" @submit.prevent="submit">
                    <!-- Token rows wrap to the column, including when chat is docked. -->
                    <!-- Compact spacing keeps revoke rows aligned with the invite form. -->
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            v-model="label"
                            type="text"
                            autocomplete="off"
                            :placeholder="t(`sandbox.controlTokensSection.labelEGNightly`)"
                            :class="ui.inputSm(`min-w-48 flex-1`)"
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
                    </div>
                    <!-- The cost of the rung, in the picker's own words, under the form where the choice is made. -->
                    <p v-if="scopeOptions.length === 1 && scopeOptions[0]" class="text-2xs text-subtle">{{ scopeOptions[0].hint }}</p>
                </form>

                <div v-if="minted" class="flex flex-col gap-2 rounded-lg bg-canvas p-3">
                    <p class="text-2xs text-subtle">{{ t(`sandbox.controlTokensSection.shownOnceCopyNow`) }}</p>
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
    </RowGroup>
</template>
