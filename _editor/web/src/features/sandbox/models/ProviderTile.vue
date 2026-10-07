<script setup lang="ts">
import { type AgentProvider, providerSpec } from "@intentic/sandbox-contract";
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { accessStateFor, connectPitch } from "../../chat/session/access";
import { turnDefaults } from "../../chat/run/turnDefaults";
import ProviderLogo from "../../chat/accounts/ProviderLogo.vue";
import { requirementWords, runsWords } from "../../chat/accounts/providerWords";
import { useT } from "@intentic/ui/i18n";

// One provider as a pressable tile in the connect view: its mark, what it is called, what it needs, and whether this
// sandbox already holds it. Says the price on the tile rather than behind it, so comparing providers costs no clicks.

const t = useT();

const {
    provider,
    selected = false,
    signingIn = false,
} = defineProps<{
    provider: AgentProvider;
    // Picked and asking a question of its own before anything starts (which estate).
    selected?: boolean;
    // Its sign-in is the one running, in the card at the top of the view: the tile says so instead of what it costs, so a
    // reader scanning the lane can tell which provider the card belongs to.
    signingIn?: boolean;
}>();
const marked = computed(() => selected || signingIn);

const spec = computed(() => providerSpec(provider));
const state = computed(() => accessStateFor(provider));
// The vendor's own noun for what the reader has to have ("Claude subscription", "Google sign-in"), in the reader's language.
const requirement = computed(() => (spec.value === undefined ? `` : requirementWords(spec.value.access, `name`)));
const runs = computed(() => (spec.value === undefined ? `` : runsWords(spec.value.access)));
// What the press is, said in full for a reader who hears the tile rather than seeing it: the visible text is three
// fragments in three places, which is legible to an eye and nothing to a screen reader. Asked against the harness a new
// turn would actually run on, which is the only thing Grok's answer depends on.
const pressName = computed(() => connectPitch(provider, turnDefaults.harness.value)?.action);
</script>

<template>
    <button
        type="button"
        class="ui-row-select ui-off flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors"
        :class="marked ? `border-primary-500/60 bg-primary-500/5` : `border-line bg-card hover:border-line-strong`"
        :aria-pressed="marked"
        :aria-label="pressName"
    >
        <ProviderLogo :provider="provider" class="mt-0.5 shrink-0 text-base" :class="marked ? `text-primary-500` : `text-muted`" />
        <span class="flex min-w-0 flex-1 flex-col gap-0.5">
            <span class="flex items-center gap-1.5">
                <span class="truncate text-sm font-medium text-content">{{ spec?.accountLabel }}</span>
                <!-- A connected provider keeps its tile (a second account, a reconnect) and says so rather than vanishing. -->
                <Icon
                    v-if="state.ready"
                    name="check"
                    class="shrink-0 text-2xs text-success"
                    :aria-label="t(`connect.providerTile.connected`)"
                />
                <Icon
                    v-if="state.needsReauth"
                    name="exclamation-triangle"
                    class="shrink-0 text-2xs text-warning"
                    :aria-label="t(`connect.providerTile.needsReconnect`)"
                />
            </span>
            <span class="text-2xs text-muted">{{ t(`connect.providerTile.runs`, { runs }) }}</span>
        </span>
        <span v-if="signingIn" class="shrink-0 rounded bg-primary-500/15 px-1.5 py-0.5 text-[0.6rem] font-medium text-primary-500">{{
            t(`connect.providerTile.signingIn`)
        }}</span>
        <span
            v-else
            class="shrink-0 rounded px-1.5 py-0.5 text-[0.6rem] font-medium"
            :class="spec?.access.kind === `free` ? `bg-success/15 text-success` : `bg-content/5 text-subtle`"
            >{{ requirement }}</span
        >
    </button>
</template>
