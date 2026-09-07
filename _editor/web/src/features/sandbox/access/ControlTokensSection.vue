<script setup lang="ts">
import { CONTROL_SCOPE_REACH, type ControlScope } from "@intentic/sandbox-contract";
import { Button, Code, CopyButton, Notice, Picker, type PickerOption, Row, RowGroup, RowNote, StatusBadge, ui } from "@intentic/ui";
import { formatDate, timeAgo } from "@intentic/ui/format";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { type ControlToken, useControlTokens } from "./useControlTokens";
import { useSandbox } from "../client/useSandbox";

/* API TOKENS: the credential a PROGRAM presents to this sandbox, minted here by the owner. One component, two
 * mounts. The Access tab mounts it whole (every scope, the roster, every snippet) because "what may reach this
 * sandbox" is that tab's subject and a token is one more thing that may. The Devices tab mounts the editor
 * slice of it (one scope, no roster, the editor snippet), because pairing an editor is a thing you do from the
 * page about your own machine, and the token it needs is a means rather than the subject.
 *
 * THE SCOPE IS TAUGHT WHERE IT IS CHOSEN. The picker's rows carry short "Can…" hints in the same voice as the
 * member-role picker on the Access tab; CONTROL_SCOPE_REACH stays the long form for OpenAPI and the site.
 *
 * SHOWN ONCE. The daemon returns the raw value at mint and keeps only its hash, so the token is on screen
 * exactly until this component is left. The snippets under it are the three ways a program holds one, each
 * paste-ready for the place it goes: a shell, a GitHub workflow's secret store, an editor's agent settings. */

const {
    scopes = [`read`, `drive`, `land`, `editor`],
    snippets = [`curl`, `github`, `acp`],
    roster = true,
    defaultExpiry = `90`,
} = defineProps<{
    // Which rungs this mount offers. The Devices card offers the editor slice alone.
    scopes?: readonly ControlScope[];
    // Which paste-ready forms to show under a freshly minted token.
    snippets?: readonly (`curl` | `github` | `acp`)[];
    // Whether to list every token against this sandbox here (the Access tab) or point at the tab that does.
    roster?: boolean;
    defaultExpiry?: Expiry;
}>();

type Expiry = `30` | `90` | `365` | `never`;

const { daemonUrl, active } = useSandbox();
const { tokens, minted, minting, notice, mint, revoke } = useControlTokens();

const isOwner = computed(() => active.value?.role === `owner`);

const SCOPE_ICONS: Record<ControlScope, PickerOption[`icon`]> = { editor: `code`, read: `eye`, drive: `play`, land: `check-circle` };

/* Short "Can…" sentences for the picker, in the same voice as the member-role picker on this tab. The contract's
 * CONTROL_SCOPE_REACH rows stay long for OpenAPI and the site; here the choice is taught in two lines. */
const SCOPE_HINTS: Record<ControlScope, string> = {
    editor: `Can run one conversation: turns, cards, transcripts. Can't see the fleet or land work.`,
    read: `Can watch everything a viewer sees. Can't change anything.`,
    drive: `Can drive agents and steer turns. Can't land or purge worktrees.`,
    land: `Can land and purge conversation worktrees. The broadest credential a program holds.`,
};

// The picker's rows ARE the model: label (lowercase scope, capitalized in CSS), then the teaching sentence.
const scopeOptions = computed<readonly PickerOption<ControlScope>[]>(() =>
    CONTROL_SCOPE_REACH.filter((entry) => scopes.includes(entry.scope)).map((entry) => ({
        value: entry.scope,
        label: entry.scope,
        icon: SCOPE_ICONS[entry.scope],
        hint: SCOPE_HINTS[entry.scope],
    })),
);

const EXPIRY_OPTIONS: readonly PickerOption<Expiry>[] = [
    { value: `30`, label: `30 days` },
    { value: `90`, label: `90 days` },
    { value: `365`, label: `1 year` },
    {
        value: `never`,
        label: `Never`,
        hint: `Lives until revoked. Right for an editor on your own laptop; wrong for a secret in someone else's store.`,
    },
];

const label = ref(``);
const scope = ref<ControlScope | undefined>(scopes[0]);
const expiry = ref<Expiry | undefined>(defaultExpiry);

const expiresAtOf = (choice: Expiry | undefined): number | undefined =>
    choice === undefined || choice === `never` ? undefined : Date.now() + Number(choice) * 24 * 60 * 60 * 1000;

const submit = async (): Promise<void> => {
    if (scope.value === undefined || minting.value) {
        return;
    }
    const expiresAt = expiresAtOf(expiry.value);
    await mint({ label: label.value, scope: scope.value, ...(expiresAt === undefined ? {} : { expiresAt }) });
    label.value = ``;
};

// ---- the paste-ready forms ----

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

/* The GitHub step runs the Marketplace action's run door (intentic/gate-action): the token goes in the repo's
 * secret store once and the workflow names it. The URL is the sandbox's own address, which is not a secret. */
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
    return snippets.filter((kind) => (kind === `acp` ? rung === `editor` : kind === `github` ? rung === `drive` || rung === `land` : true));
});

// ---- the roster ----

const now = ref(Date.now());

const expired = (token: ControlToken): boolean => token.expiresAt !== undefined && token.expiresAt <= now.value;

/* ONE SENTENCE UNDER THE LABEL, not facts in the row's meta column. The meta column does not shrink, so at a
 * phone's width two dates and a button there squeezed the headline to forty pixels and wrapped "nightly CI"
 * onto two lines and its description onto five. A sentence wraps where it needs to and the row keeps one
 * control on the right; the one fact that earns colour, an expired token, stays in the column as a single word. */
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
    <RowGroup v-if="isOwner" label="API tokens" :count="roster && tokens.length > 0 ? tokens.length : undefined">
        <template v-if="roster">
            <Row v-for="token in tokens" :key="token.id" icon="key" :title="token.label" :description="describe(token)">
                <!-- The same pill the member roster draws two groups up, because it is the same word about the
                     same thing. Written as bare `text-danger` text it was "Expired" against that list's
                     "expired", one tab, one fact column, two spellings. -->
                <template v-if="expired(token)" #meta>
                    <StatusBadge variant="danger" label="expired" size="xs" />
                </template>
                <template #control>
                    <Button label="Revoke" size="small" severity="danger" :text="true" @click="revoke(token.id)" />
                </template>
            </Row>
            <RowNote v-if="tokens.length === 0">No program holds a token to this sandbox yet.</RowNote>
        </template>
        <RowNote v-else>
            Every token against this sandbox is listed, and revoked, on
            <RouterLink to="/sandbox/access" class="text-link">Access</RouterLink>.
        </RowNote>

        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <Notice v-if="notice" :of="notice" />
                <form class="flex flex-col gap-2" @submit.prevent="submit">
                    <!-- WRAPS BY THE COLUMN, NOT THE VIEWPORT. A `sm:` breakpoint put the field beside the pickers on
                         any wide screen, and with the chat docked this column is a phone's width on a wide screen,
                         which squeezed the field to a black stub. The field keeps a minimum and takes the remaining
                         width; the controls drop to their own line when that remainder is too small to type in. -->
                    <!-- THE COMPACT TIER, the same call the invite form makes one group up, and for the same
                         reason: this is a LIST'S FOOTER, under rows whose Revoke button is 26px, and both of
                         this component's mounts are dense (the Access tab's roster, the Devices tab's card,
                         which sizes its own folder field at `ui.inputSm`). Field, pickers and button take one
                         height, so the strip is one control tall instead of three boxes of two sizes. -->
                    <div class="flex flex-wrap items-center gap-2">
                        <input
                            v-model="label"
                            type="text"
                            autocomplete="off"
                            placeholder="Label, e.g. nightly CI"
                            :class="ui.inputSm(`min-w-48 flex-1`)"
                        />
                        <div class="flex min-w-0 flex-wrap items-center gap-2">
                            <Picker
                                v-if="scopeOptions.length > 1"
                                v-model="scope"
                                :options="scopeOptions"
                                variant="input"
                                aria-label="Token scope"
                                header="Scope"
                                label-class="capitalize"
                                class="ui-field-sm w-32"
                            />
                            <Picker
                                v-model="expiry"
                                :options="EXPIRY_OPTIONS"
                                variant="input"
                                aria-label="Token expiry"
                                header="Expires"
                                class="ui-field-sm w-32"
                            />
                            <Button
                                type="submit"
                                label="Mint token"
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
                    <p class="text-2xs text-subtle">Shown once: copy it now. The sandbox stores only a hash.</p>
                    <div class="flex items-center gap-2">
                        <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ minted.token }}</code>
                        <CopyButton :text="minted.token" label="Copy" />
                    </div>
                    <Code v-if="shownSnippets.includes(`curl`)" :code="curlSnippet" lang="bash" label="A shell, anywhere" :wrap="true" />
                    <Code
                        v-if="shownSnippets.includes(`github`)"
                        :code="githubSnippet"
                        lang="yaml"
                        label="GitHub Actions: the token goes in a repository secret named INTENTIC_TOKEN"
                    />
                    <Code
                        v-if="shownSnippets.includes(`acp`)"
                        :code="acpSnippet"
                        lang="json"
                        label="Zed → settings.json (JetBrains takes the same command + env)"
                    />
                </div>
            </div>
        </RowNote>
    </RowGroup>
</template>
