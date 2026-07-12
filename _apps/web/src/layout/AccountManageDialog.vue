<script setup lang="ts">
import { CopyButton } from "@intentic-app/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, ref } from "vue";
import { providerTabs } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";

/* Global, body-portaled account-management dialog. Mounted once in WorkspaceShell so openAccountManage() works
 * the same from the chat composer, the Secrets page, and the Sandbox page — desktop and mobile alike. Everything
 * runs off `managedProvider` (decoupled from the active chat's provider), so managing accounts never touches the
 * active conversation. The connect handshake's open-URL anchors stay real user-gesture clicks inside the dialog. */

const {
    managedProvider,
    setManagedProvider,
    managedAccounts,
    authorizeUrl,
    userCode,
    connectLabel,
    accountManageOpen,
    accountUsage,
    error: chatError,
    closeAccountManage,
    startConnect,
    completeConnect,
    disconnect,
} = useChat();

// Compact "142k" token count and a short usage summary line per account (from /system/usage).
const shortTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const usageLine = (id: string): string | undefined => {
    const usage = accountUsage.value[id];
    if (usage === undefined || usage.turns === 0) {
        return undefined;
    }
    const cost = usage.costUsd > 0 ? ` · $${usage.costUsd.toFixed(2)}` : ``;
    // Cache read = prompt tokens served from the provider's cache; the rate is the share of prompt input that
    // hit the cache (read / (read + uncached input)) — how effective prefix caching is for this account.
    const cacheDenom = usage.cacheReadTokens + usage.inputTokens;
    const cache =
        usage.cacheReadTokens > 0 && cacheDenom > 0
            ? ` · ${shortTokens(usage.cacheReadTokens)} cached (${Math.round((100 * usage.cacheReadTokens) / cacheDenom)}%)`
            : ``;
    return `${usage.turns} turns · ${shortTokens(usage.inputTokens)} in / ${shortTokens(usage.outputTokens)} out${cache}${cost}`;
};

const accountTitle = computed(() => (managedProvider.value === `codex` ? `ChatGPT accounts` : managedProvider.value === `grok` ? `Grok accounts` : `Claude accounts`));
// The flows differ: Anthropic shows a code on its hosted page to paste back; ChatGPT uses a device code (the
// user enters it on OpenAI's page and this panel connects on its own); Grok (xAI OAuth) opens x.ai on any
// device and connects on approval (a paste-back code only for the non-device method).
const connectHint = computed(() =>
    managedProvider.value === `codex`
        ? `Open ChatGPT, sign in, and enter this one-time code — the app connects automatically.`
        : managedProvider.value === `grok`
          ? `Open x.ai on any device with your SuperGrok / X Premium account and approve — this connects on its own.`
          : `Open Anthropic to authorize, then paste the code it shows you.`,
);
const openLabel = computed(() => (managedProvider.value === `codex` ? `Open ChatGPT` : managedProvider.value === `grok` ? `Open x.ai` : `Open Anthropic`));
const pastePlaceholder = computed(() => (managedProvider.value === `codex` ? `Paste localhost URL…` : `Paste code…`));
// Grok holds a single account (OpenCode owns the xAI credential), so hide "connect another" once it's linked.
const canConnectMore = computed(() => managedProvider.value !== `grok` || managedAccounts.value.length === 0);
// A connect handshake is live once startConnect has produced its authorize URL / device code.
const connecting = computed(() => authorizeUrl.value !== null);

const connectCode = ref(``);

const finishConnect = async (): Promise<void> => {
    const code = connectCode.value.trim();
    if (code.length === 0) {
        return;
    }
    const ok = await completeConnect(code);
    if (ok) {
        connectCode.value = ``;
    }
};
</script>

<template>
    <Dialog
        :visible="accountManageOpen"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :show-header="false"
        :style="{ width: '28rem' }"
        :pt="{ content: '!p-0 !overflow-hidden !rounded-lg' }"
        @update:visible="(v: boolean) => { if (!v) closeAccountManage(); }"
    >
        <div class="flex flex-col gap-2 px-3 py-3 text-sm">
            <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-content">{{ accountTitle }}</span>
                <div class="flex items-center gap-1">
                    <button
                        v-for="tab in providerTabs"
                        :key="tab.value"
                        type="button"
                        class="composer-ghost h-6 px-2 text-2xs font-medium"
                        :class="{ 'composer-active': managedProvider === tab.value }"
                        @click="setManagedProvider(tab.value)"
                        :aria-pressed="managedProvider === tab.value"
                    >
                        {{ tab.label }}
                    </button>
                    <button type="button" class="composer-ghost h-6 w-6" @click="closeAccountManage" aria-label="Close">
                        <Icon name="times" class="text-2xs" />
                    </button>
                </div>
            </div>

            <p v-if="chatError" class="text-2xs text-danger">{{ chatError }}</p>

            <!-- Connected accounts for the managed provider; each can be disconnected independently. -->
            <ul v-if="managedAccounts.length > 0" class="flex flex-col gap-1">
                <li
                    v-for="account in managedAccounts"
                    :key="account.id"
                    class="flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5"
                    :class="account.needsReauth ? 'border-warning/40 bg-warning/10' : 'border-line bg-card'"
                >
                    <span class="flex min-w-0 flex-col">
                        <span class="flex min-w-0 items-center gap-2">
                            <Icon name="circle-fill" class="text-[0.5rem]" :class="account.needsReauth ? 'text-warning' : 'text-success'" />
                            <span class="truncate text-2xs text-content">{{ account.label }}</span>
                        </span>
                        <!-- A revoked/expired credential explains itself and offers reconnect; else the usage line. -->
                        <span v-if="account.needsReauth" class="pl-3.5 text-[0.65rem] text-warning">{{ account.detail ?? `Reconnect to keep using this account.` }}</span>
                        <span v-else-if="usageLine(account.id)" class="pl-3.5 text-[0.65rem] text-subtle">{{ usageLine(account.id) }}</span>
                    </span>
                    <div class="flex shrink-0 items-center gap-1">
                        <Button v-if="account.needsReauth && canConnectMore" label="Re-log in" size="small" @click="startConnect">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                        <Button label="Disconnect" size="small" severity="danger" :text="true" @click="disconnect(account.id)">
                            <template #icon><Icon name="sign-out" /></template>
                        </Button>
                    </div>
                </li>
            </ul>
            <p v-else class="text-2xs text-subtle">No {{ providerTabs.find((t) => t.value === managedProvider)?.label }} account connected yet.</p>

            <!-- Connect another account: a labelled sign-in handshake (kicked off on demand so the open-URL anchor
                 is a real user gesture, never a blocked programmatic popup). -->
            <div v-if="canConnectMore" class="flex flex-col gap-2 border-t border-line pt-2">
                <Button v-if="!connecting" label="Connect another account" size="small" @click="startConnect">
                    <template #icon><Icon name="link" /></template>
                </Button>
                <template v-else>
                    <p class="text-2xs text-subtle">{{ connectHint }}</p>
                    <input
                        v-model="connectLabel"
                        name="accountLabel"
                        placeholder="Account name (optional)"
                        class="min-w-0 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    />
                    <template v-if="managedProvider === `codex`">
                        <div v-if="userCode" class="flex flex-col items-center gap-1 rounded-md border border-line bg-card py-2">
                            <span class="text-2xs text-subtle">Your one-time code</span>
                            <span class="font-mono text-lg font-semibold tracking-[0.2em] text-content">{{ userCode }}</span>
                            <CopyButton :text="userCode ?? ``" label="Copy" />
                        </div>
                        <div class="flex items-center gap-2">
                            <Button v-if="authorizeUrl" as="a" :label="openLabel" size="small" severity="secondary" :href="authorizeUrl" target="_blank" rel="noopener">
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                            <span v-if="userCode" class="text-2xs text-subtle"><Icon name="spinner" class="mr-1" spin />Waiting for you to finish signing in…</span>
                        </div>
                    </template>
                    <template v-else-if="managedProvider === `grok`">
                        <div v-if="userCode" class="flex flex-col items-center gap-1 rounded-md border border-line bg-card py-2">
                            <span class="text-2xs text-subtle">Code (already filled in at x.ai — just approve)</span>
                            <span class="font-mono text-lg font-semibold tracking-[0.2em] text-content">{{ userCode }}</span>
                            <CopyButton :text="userCode ?? ``" label="Copy" />
                        </div>
                        <div class="flex items-center gap-2">
                            <Button v-if="authorizeUrl" as="a" :label="openLabel" size="small" severity="secondary" :href="authorizeUrl" target="_blank" rel="noopener">
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                            <span v-if="userCode" class="text-2xs text-subtle"><Icon name="spinner" class="mr-1" spin />Waiting for you to approve…</span>
                        </div>
                    </template>
                    <div v-else class="flex flex-col gap-2">
                        <div class="flex items-center gap-2">
                            <Button v-if="authorizeUrl" as="a" :label="openLabel" size="small" severity="secondary" :href="authorizeUrl" target="_blank" rel="noopener">
                                <template #icon><Icon name="external-link" /></template>
                            </Button>
                        </div>
                        <div class="flex gap-2">
                            <input
                                v-model="connectCode"
                                name="connectCode"
                                :placeholder="pastePlaceholder"
                                class="min-w-0 flex-1 rounded-md border border-line bg-card px-3 py-1.5 text-sm text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                                @keydown.enter="finishConnect"
                            />
                            <Button label="Finish" size="small" :disabled="connectCode.trim().length === 0" @click="finishConnect" />
                        </div>
                    </div>
                </template>
            </div>
        </div>
    </Dialog>
</template>
