<script setup lang="ts">
import { Card, Code, CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import { useBridgeTokens } from "../../composables/sandbox/useBridgeTokens";

/* The Editor bridge (ACP) card: drive this sandbox's agents from Zed / JetBrains / any ACP editor. Mint a
 * bridge token (shown once), paste the generated agent_servers snippet into the editor, open your synced
 * folder as the project. Sits beside Desktop sync — the two halves of "work from your own machine". */

const { tokens, minted, minting, error, label, mint, revoke, zedSnippet } = useBridgeTokens();
</script>

<template>
    <Card class="flex flex-col gap-3">
        <div class="flex items-center gap-2">
            <Icon name="code" class="text-sm text-link" />
            <h2 class="text-sm font-semibold text-content">Editor bridge (ACP)</h2>
        </div>
        <p class="text-xs text-muted">
            Drive this sandbox's agents from Zed, JetBrains, or any ACP editor: mint a token, paste the snippet into your editor's agent settings, and
            open your synced folder as the project so edits and diffs line up.
        </p>
        <p class="text-2xs text-warning">
            A bridge token lets its holder run the agent — which edits files and runs commands in this sandbox. Treat it like a password; revoke it
            here if it leaks.
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
        <p v-if="error" class="text-2xs text-danger">{{ error }}</p>

        <div v-if="minted" class="flex flex-col gap-2 rounded-lg bg-canvas p-3">
            <p class="text-2xs text-subtle">Shown once — copy it now. The sandbox stores only a hash.</p>
            <div class="flex items-center gap-2">
                <code class="min-w-0 flex-1 truncate font-mono text-xs text-content">{{ minted.token }}</code>
                <CopyButton :text="minted.token" label="Copy" />
            </div>
            <!-- The shared code block: it is JSON going into a settings file, so it is coloured as JSON and
                 carries its own copy button — the snippet's whole purpose is to be pasted elsewhere. -->
            <Code :code="zedSnippet" lang="json" label="Zed → settings.json (JetBrains takes the same command + env)" />
        </div>

        <ul v-if="tokens.length > 0" class="flex flex-col gap-1">
            <li v-for="token in tokens" :key="token.id" class="flex items-center gap-2 text-xs">
                <Icon name="key" class="text-2xs text-subtle" />
                <span class="text-content">{{ token.label }}</span>
                <span class="text-2xs text-subtle">{{ new Date(token.createdAt).toLocaleDateString() }}</span>
                <Button label="Revoke" size="small" severity="danger" :text="true" class="ml-auto" @click="revoke(token.id)" />
            </li>
        </ul>
    </Card>
</template>
