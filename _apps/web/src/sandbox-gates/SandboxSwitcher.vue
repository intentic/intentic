<script setup lang="ts">
import type { SandboxSummary } from "@intentic-app/api-contract";
import { Code, commandLang, ConfirmDialog, type IconName, OS_OPTIONS, Segmented, useOsPreference } from "@intentic/ui";
import type { ViewBadge } from "@intentic/extension-api";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import Popover from "primevue/popover";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { type SandboxAttentionItem, useSandboxAttention } from "../composables/sandbox/sandboxAttention";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useAuth } from "../composables/useAuth";
import { bashCommand, psCommand } from "../environments/scriptCommand";

/* Rail control to switch between the user's sandboxes (owned + shared) or add another. The active sandbox drives
 * the whole workspace (useSandbox) — selecting here re-points every sandbox-backed view + the liveness probe at
 * the chosen daemon. Settings, access and everything else about the active sandbox live on the tabbed /sandbox
 * hub (opened from here). Plan-gated "Add sandbox" preflights the loaded entitlements to upsell early — the
 * API's 402 is the real gate. */

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
const { entitlements, upgradeOpen } = useAuth();
// Everything the sandbox needs from its owner (sandboxAttention): a corner badge on the chip, and one routed
// row per item inside the popover. The hub behind them has no rail tile, so without this the only way to learn
// a rebuild is pending would be to go asking — which is the hole the bars above the app used to plug.
const { items: attention, badge: attentionBadge } = useSandboxAttention();
const { cmdOs } = useOsPreference();
// ONE label for the whole control, badge included — the rail's tileLabel rule. A tooltip on the badge itself
// would open a second box on top of this one (it is a descendant), and the badge is a glyph or a bare number,
// so this string is the only place its sentence exists.
const switcherLabel = computed(() => {
    const name = sandbox.active.value?.name ?? `Sandboxes`;
    const tooltip = attentionBadge.value?.tooltip;
    return tooltip === undefined ? name : `${name} · ${tooltip}`;
});

const BADGE_TONE: Record<NonNullable<ViewBadge["tone"]>, string> = {
    info: `bg-primary-600/15 text-link`,
    warning: `bg-warning/15 text-warning`,
    danger: `bg-danger/15 text-danger`,
};
const ROW_TONE: Record<SandboxAttentionItem["tone"], string> = {
    info: `text-link`,
    warning: `text-warning`,
};

const panel = ref<InstanceType<typeof Popover> | null>(null);

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

/* Switching to a sandbox that has never reported in is not switching to anything: it has no daemon, so the
 * shell can only paint a connecting gate that cannot resolve. What that row actually is, is an unfinished
 * setup — so picking it goes back there and resumes it, which is also the only place it can become a
 * workspace. (The router's requireSetup keeps the same row out of the shell on a cold load; this is the same
 * rule from inside, for an account that has one working sandbox and one it never started.) */
const pick = (option: SandboxSummary): void => {
    panel.value?.hide();
    if (option.lastSeenAt === null) {
        void router.push({ path: `/setup`, query: { sandbox: option.id } });
        return;
    }
    sandbox.select(option.id);
};

// The sandbox management hub has no rail tile — this chip is its home (identity → tabbed settings surface), and
// it is where every attention row lands too: each names a tab of the same hub.
const openTab = (to: string): void => {
    panel.value?.hide();
    void router.push(to);
};

const addSandbox = (): void => {
    panel.value?.hide();
    const limit = entitlements.value?.sandboxLimit;
    if (limit !== undefined && sandbox.sandboxes.value.filter((option) => option.role === `owner`).length >= limit) {
        upgradeOpen.value = true;
        return;
    }
    void router.push(`/setup`);
};

// The sandbox awaiting removal confirmation (owner: drops the platform record for everyone; member: leaves).
// Non-destructive either way — the daemon keeps running on its host; teardown is the cleanup script's job,
// so the owner dialog surfaces that command (cleanupCommand) for the machine hosting it.
const pending = ref<SandboxSummary | undefined>(undefined);
const cleanupSlug = ref<string | undefined>(undefined);

// The container slug on the hosting machine: the hostname's first label (sandbox-<id> or a custom subdomain,
// both equal connect.sh's SLUG), or — for a sandbox that never announced a daemonUrl — the same
// sandbox-<sha256(token)[:12]> derivation Setup.vue pre-fills the subdomain with (must mirror the CLI).
watch(pending, async (target) => {
    if (target === undefined || target.role !== `owner`) {
        cleanupSlug.value = undefined;
        return;
    }
    if (target.daemonUrl !== null) {
        cleanupSlug.value = new URL(target.daemonUrl).hostname.split(`.`)[0] ?? ``;
        return;
    }
    const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(target.token));
    const hex = Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, `0`))
        .join(``);
    cleanupSlug.value = sandboxSubdomain(hex.slice(0, 12));
});

// The host may be a Windows PC (the /setup command has a PowerShell lane, so it can be), where the POSIX
// one-liner is unrunnable — so the teardown follows the same shared Linux/Windows preference every other
// command surface uses. cleanup.ps1 takes PowerShell parameters, not cleanup.sh's positional slug + -y.
const cleanupCommand = computed(() => {
    const slug = cleanupSlug.value;
    if (slug === undefined) {
        return undefined;
    }
    return cmdOs.value === `windows` ? psCommand(`cleanupPs1`, ``, `-Slug ${slug} -Yes`) : bashCommand(`cleanup`, ``, `${slug} -y`);
});

const askRemove = (option: SandboxSummary): void => {
    panel.value?.hide();
    pending.value = option;
};

const confirmRemove = async (): Promise<void> => {
    const target = pending.value;
    pending.value = undefined;
    if (target === undefined) {
        return;
    }
    const removal = sandbox.remove(target.id);
    // remove() drops the row synchronously before its first await, so the empty check is valid here.
    if (sandbox.sandboxes.value.length === 0) {
        void router.push(`/setup`);
    }
    await removal;
};
</script>

<template>
    <!-- The rail's top control: a live chip for the active sandbox (initial + online status), click to switch.
         The corner overlays are siblings of the button, not children: the button clips (overflow-hidden is what
         crops a custom image to the tile's rounded square), so an overlay inside it loses whatever hangs past
         the edge — and both of these are meant to hang past it. The wrapper carries the positioning context;
         pointer-events-none keeps them from stealing the click that opens the switcher. -->
    <span class="relative flex">
        <button
            type="button"
            class="sandbox-switcher flex items-center justify-center overflow-hidden rounded-lg border border-line transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
            :class="route.path.startsWith('/sandbox') ? 'bg-primary-600/15 text-link' : 'bg-card text-muted'"
            :aria-label="`Switch sandbox: ${switcherLabel}`"
            v-tooltip.right="switcherLabel"
            @click="panel?.toggle($event)"
        >
            <img v-if="sandbox.active.value?.image" :src="sandbox.active.value.image" alt="" class="h-full w-full object-cover" />
            <span v-else-if="sandbox.active.value?.name" class="text-base font-semibold uppercase text-content">{{
                sandbox.active.value.name.charAt(0)
            }}</span>
            <Icon name="server" v-else class="text-lg" />
        </button>
        <!-- What the sandbox needs from its owner, as one corner badge: the head item's count where the amount
             is the message, its glyph otherwise. aria-hidden because the button's own label already says every
             pending sentence in words — a bare number read out of context tells a screen reader nothing. -->
        <span
            v-if="attentionBadge"
            class="pointer-events-none absolute -right-1 -top-1 flex min-w-4 items-center justify-center rounded-full px-1 text-center text-[0.6rem] font-semibold leading-4"
            :class="BADGE_TONE[attentionBadge.tone ?? `info`]"
            aria-hidden="true"
        >
            <Icon v-if="attentionBadge.mark !== undefined" :name="attentionBadge.mark as IconName" />
            <template v-else>{{ (attentionBadge.count ?? 0) > 99 ? `99+` : attentionBadge.count }}</template>
        </span>
        <span
            class="pointer-events-none absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card"
            :class="sandbox.reachable.value ? 'bg-success' : 'bg-subtle'"
        ></span>
    </span>

    <Popover ref="panel" append-to="body">
        <div class="flex w-64 flex-col gap-0.5 p-1">
            <!-- The badge's detail: one row per pending item, each routing to the hub tab that resolves it.
                 First in the popover because the badge is what brought the reader here, and each row is the
                 whole sentence its bar used to shout — said once, where it was asked for. -->
            <template v-if="attention.length > 0">
                <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Needs you</div>
                <button
                    v-for="item in attention"
                    :key="item.message"
                    type="button"
                    class="flex items-center gap-2.5 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-content/5"
                    @click="openTab(item.to)"
                >
                    <span class="flex h-6 w-6 shrink-0 items-center justify-center" :class="ROW_TONE[item.tone]">
                        <Icon :name="item.icon" class="text-sm" />
                    </span>
                    <span class="min-w-0 flex-1 text-xs text-content">{{ item.message }}</span>
                    <Icon name="chevron-right" class="shrink-0 text-xs text-subtle" />
                </button>
                <div class="my-1 border-t border-line"></div>
            </template>

            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Sandboxes</div>

            <button
                v-for="option in sandbox.sandboxes.value"
                :key="option.id"
                type="button"
                class="group flex items-center gap-2.5 rounded-md px-2 py-1 text-left text-sm transition-colors"
                :class="option.id === sandbox.activeSandboxId.value ? 'bg-primary-600/15' : 'hover:bg-content/5'"
                @click="pick(option)"
            >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-card text-muted">
                    <img v-if="option.image" :src="option.image" alt="" class="h-full w-full object-cover" />
                    <Icon name="server" v-else class="text-sm" />
                </span>
                <span class="min-w-0 flex-1 truncate" :class="option.id === sandbox.activeSandboxId.value ? 'text-link' : 'text-content'">{{
                    option.name
                }}</span>
                <span
                    v-if="option.id === sandbox.activeSandboxId.value"
                    class="shrink-0 h-1.5 w-1.5 rounded-full"
                    :class="sandbox.reachable.value ? 'bg-success' : 'bg-subtle'"
                    v-tooltip.top="sandbox.reachable.value ? 'online' : 'offline'"
                ></span>
                <!-- Says what it is before it is clicked, so the jump back to setup reads as the answer to the
                     row rather than as the switcher losing its place. Same chrome as "Shared" — both are facts
                     about the row, not states of the connection (that is the dot above). -->
                <span v-if="option.lastSeenAt === null" class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle"
                    >Setup</span
                >
                <span v-else-if="option.role === 'member'" class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle"
                    >Shared</span
                >
                <Icon
                    name="trash"
                    @click.stop="askRemove(option)"
                    v-tooltip.top="option.role === 'owner' ? 'Remove from account' : 'Leave'"
                    class="shrink-0 text-xs opacity-0 transition-opacity hover:text-danger group-hover:opacity-60"
                />
            </button>

            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-sm text-content transition-colors hover:bg-content/5"
                @click="addSandbox"
            >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center">
                    <Icon name="plus" class="text-base text-muted" />
                </span>
                Add sandbox
            </button>

            <div class="my-1 border-t border-line"></div>

            <button
                type="button"
                class="flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-sm text-content transition-colors hover:bg-content/5"
                @click="openTab('/sandbox')"
            >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center">
                    <Icon name="cog" class="text-base text-muted" />
                </span>
                Sandbox settings
            </button>
        </div>
    </Popover>

    <ConfirmDialog
        :open="pending !== undefined"
        :header="pending?.role === 'owner' ? 'Remove from account?' : 'Leave sandbox?'"
        :confirm-label="pending?.role === 'owner' ? 'Remove' : 'Leave'"
        confirm-icon="trash"
        @cancel="pending = undefined"
        @confirm="confirmRemove"
    >
        <p v-if="pending" class="text-sm text-content">
            {{
                pending.role === "owner"
                    ? `Remove "${pending.name}" from your account? Everyone loses access here; the sandbox itself keeps running wherever it is.`
                    : `Leave "${pending.name}"? You lose access; the sandbox keeps running.`
            }}
        </p>
        <template v-if="pending?.role === 'owner' && cleanupCommand !== undefined">
            <p class="mt-3 text-sm text-muted">To also remove it from the machine hosting it — including its files — run there:</p>
            <Segmented class="mt-2" v-model="cmdOs" :options="OS_OPTIONS" />
            <Code class="mt-1.5" :code="cleanupCommand" :lang="commandLang(cmdOs)" label="Cleanup command" :wrap="true" />
        </template>
    </ConfirmDialog>
</template>

<style scoped>
.sandbox-switcher {
    width: var(--icon-rail-tile-size, 2.75rem);
    height: var(--icon-rail-tile-size, 2.75rem);
}
</style>
