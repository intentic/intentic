<script setup lang="ts">
import { Button, Card, Code, CopyButton, formatDate, Notice, Row } from "@intentic/ui";
import { computed } from "vue";
import { useControlTokens } from "../../composables/sandbox/useControlTokens";
import { useSandbox } from "../../composables/sandbox/useSandbox";

/* The Editor bridge (ACP) card: run this sandbox's agents from Zed, JetBrains, or any ACP editor. Mint an
 * `editor`-scoped control token (shown once), paste the generated agent_servers snippet into the editor, then
 * open your synced folder as the project. Pairs with Desktop sync as the two halves of working from your own
 * machine.
 *
 * The snippet lives here rather than in the composable because it is Zed's settings shape, while the composable
 * is about tokens. The next card that mints one (a CLI, an MCP server) brings its own paste-ready snippet. */

const { daemonUrl } = useSandbox();
const { tokens, minted, minting, notice, label, mint, revoke } = useControlTokens(`editor`, `editor bridge`);

const zedSnippet = computed(() =>
    minted.value === undefined
        ? ``
        : JSON.stringify(
              {
                  agent_servers: {
                      intentic: {
                          type: `custom`,
                          command: `npx`,
                          args: [`@intentic/acp-bridge`],
                          env: { INTENTIC_SANDBOX_URL: daemonUrl.value ?? ``, INTENTIC_CONTROL_TOKEN: minted.value.token },
                      },
                  },
              },
              undefined,
              2,
          ),
);
</script>

<template>
    <Card class="flex flex-col gap-4">
        <Row
            flush
            :heading="2"
            icon="code"
            title="Editor bridge (ACP)"
            description="Run this sandbox's agents from Zed, JetBrains, or any ACP editor. Mint a token, paste the snippet into your editor's agent settings, then open your synced folder as the project."
        />
        <p class="text-2xs text-warning">
            An editor token lets its holder run the agent, edit files, and run commands in this sandbox. Treat it like a password. Revoke it here if
            it leaks.
        </p>

        <div class="flex items-center gap-2">
            <input
                v-model="label"
                type="text"
                placeholder="Label (e.g. Zed on laptop)"
                class="w-56 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-sm text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
            />
            <Button label="Mint token" size="small" :loading="minting" @click="mint" />
        </div>
        <Notice v-if="notice" :of="notice" />

        <div v-if="minted" class="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <p class="text-2xs text-subtle">Shown once: copy it now. The sandbox stores only a hash.</p>
            <div class="flex items-center gap-2">
                <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ minted.token }}</code>
                <CopyButton :text="minted.token" label="Copy" />
            </div>
            <!-- The shared code block: it is JSON going into a settings file, so it is coloured as JSON and
                 carries its own copy button. The snippet's whole purpose is to be pasted elsewhere. -->
            <Code :code="zedSnippet" lang="json" label="Zed → settings.json (JetBrains takes the same command + env)" />
        </div>

        <!-- Every control token against this sandbox, not just the editor ones this card mints: a revoke
             surface that hides the token somebody minted elsewhere is how a leaked one stays live. -->
        <ul v-if="tokens.length > 0" class="flex flex-col gap-1">
            <li v-for="token in tokens" :key="token.id" class="flex items-center gap-2 text-xs">
                <Icon name="key" class="text-2xs text-subtle" />
                <span class="text-content">{{ token.label }}</span>
                <span class="rounded bg-canvas px-1 py-0.5 font-mono text-2xs text-subtle">{{ token.scope }}</span>
                <span class="text-2xs text-subtle">{{ formatDate(token.createdAt) }}</span>
                <Button label="Revoke" size="small" severity="danger" :text="true" class="ml-auto" @click="revoke(token.id)" />
            </li>
        </ul>
    </Card>
</template>
