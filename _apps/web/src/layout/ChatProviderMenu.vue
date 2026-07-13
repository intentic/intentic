<script setup lang="ts">
import { computed } from "vue";
import { PROVIDERS } from "../composables/chat/catalog";
import { type ChatProvider, modelOptionsFor, providerAccounts } from "../composables/chat/conversation";
import { useChat } from "../composables/chat/useChat";
import ProviderLogo from "./ProviderLogo.vue";

/* The provider / model / extended-thinking picker body — width-agnostic so the desktop panel hosts it in a
 * Popover and the mobile panel in a BottomSheet. All state is the useChat singleton. */

const { provider, selectProvider, account, selectAccount, accounts, model, thinking, streaming, messages } = useChat();
// A provider whose (any) connected account can no longer be refreshed — badge it so a broken credential doesn't
// look identical to a healthy one until the user tries to chat.
const providerNeedsReauth = (target: ChatProvider): boolean => providerAccounts.value[target].some((entry) => entry.needsReauth === true);
// Grok's list is the live daemon catalog; the others are the static catalog. Shared with the composer chip.
const models = computed(() => modelOptionsFor(provider.value));
// The account the turn will use: the explicit pick, else the first (the daemon's default) — so the picker
// always highlights the one in effect, even before the user touches it.
const activeAccountId = computed(() => account.value ?? accounts.value[0]?.id);
</script>

<template>
    <div class="flex flex-col gap-2 p-1">
        <div class="flex items-center justify-between">
            <span class="text-2xs uppercase tracking-wide text-subtle">Provider</span>
            <!-- A session resumes only on its own runtime, so a mid-chat switch starts a fresh one seeded
                 with the transcript so far (see Conversation.send). -->
            <span v-if="messages.length > 0" class="text-2xs text-subtle">switching starts a fresh session — context carries over</span>
        </div>
        <div class="grid grid-cols-2 gap-1">
            <button
                v-for="p in PROVIDERS"
                :key="p.value"
                type="button"
                class="qopt flex h-8 items-center justify-center gap-1.5 rounded-lg border px-2 text-xs max-md:h-11"
                :class="{ 'qopt-on': provider === p.value }"
                :disabled="streaming"
                @click="selectProvider(p.value)"
            >
                <ProviderLogo :provider="p.value" :class="provider === p.value ? 'text-primary-500' : 'text-subtle'" />
                <span class="truncate text-content">{{ p.label }}</span>
                <Icon
                    v-if="providerNeedsReauth(p.value)"
                    name="exclamation-triangle"
                    class="text-2xs text-warning"
                    v-tooltip.top="'This account needs to be reconnected'"
                />
            </button>
        </div>

        <!-- Which connected account of the provider the next turn uses; only worth showing when there's a
             choice. Switchable mid-chat like the provider — a change retires the session at the next send. -->
        <template v-if="accounts.length > 1">
            <span class="text-2xs uppercase tracking-wide text-subtle">Account</span>
            <div class="flex flex-col gap-1">
                <button
                    v-for="a in accounts"
                    :key="a.id"
                    type="button"
                    class="qopt flex h-8 min-w-0 items-center rounded-lg border px-2 text-xs max-md:h-11"
                    :class="{ 'qopt-on': activeAccountId === a.id }"
                    :disabled="streaming"
                    @click="selectAccount(a.id)"
                >
                    <span class="truncate text-content">{{ a.label }}</span>
                    <Icon
                        v-if="a.needsReauth"
                        name="exclamation-triangle"
                        class="ml-auto shrink-0 text-2xs text-warning"
                        v-tooltip.top="a.detail ?? 'This account needs to be reconnected'"
                    />
                </button>
            </div>
        </template>

        <span class="text-2xs uppercase tracking-wide text-subtle">Model</span>
        <div class="flex gap-1">
            <button
                v-for="m in models"
                :key="m.value"
                type="button"
                class="qopt flex h-8 min-w-0 flex-1 items-center justify-center rounded-lg border px-2 text-xs max-md:h-11"
                :class="{ 'qopt-on': model === m.value }"
                @click="model = m.value"
            >
                <span class="truncate text-content">{{ m.label }}</span>
            </button>
        </div>

        <!-- Codex reasoning is always on (no toggle); extended thinking is a Claude knob. -->
        <div v-if="provider === `claude`" class="flex items-center justify-between gap-2 border-t border-line pt-2">
            <span class="text-2xs uppercase tracking-wide text-subtle">Extended thinking</span>
            <button
                type="button"
                class="composer-ghost h-7 gap-1 px-2.5 text-xs font-medium max-md:h-10"
                :class="{ 'composer-active': thinking }"
                @click="thinking = !thinking"
                :aria-pressed="thinking"
                aria-label="Toggle extended thinking"
            >
                <Icon name="bolt" class="text-2xs" />
                <span>{{ thinking ? "On" : "Off" }}</span>
            </button>
        </div>
    </div>
</template>
