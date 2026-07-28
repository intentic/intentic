<script setup lang="ts">
import type { SandboxSummary } from "@intentic-app/api-contract";
import { Code } from "@intentic-app/ui";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import Popover from "primevue/popover";
import { onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { bashCommand } from "../environments/scriptCommand";

/* Rail control to switch between the user's sandboxes (owned + shared) or add another. The active sandbox drives
 * the whole workspace (useSandbox) — selecting here re-points every sandbox-backed view + the liveness probe at
 * the chosen daemon. Settings, access and everything else about the active sandbox live on the tabbed /sandbox
 * hub (opened from here). Plan-gated "Add sandbox" preflights the loaded entitlements to upsell early — the
 * API's 402 is the real gate. */

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
const { entitlements, upgradeOpen } = useAuth();

const panel = ref<InstanceType<typeof Popover> | null>(null);

onMounted(() => {
    if (sandbox.sandboxes.value.length === 0) {
        void sandbox.list();
    }
});

const pick = (id: string): void => {
    sandbox.select(id);
    panel.value?.hide();
};

// The sandbox management hub has no rail tile — this chip is its home (identity → tabbed settings surface).
const openSandbox = (): void => {
    panel.value?.hide();
    void router.push(`/sandbox`);
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
const cleanupCommand = ref<string | undefined>(undefined);

// The container slug on the hosting machine: the hostname's first label (sandbox-<id> or a custom subdomain,
// both equal connect.sh's SLUG), or — for a sandbox that never announced a daemonUrl — the same
// sandbox-<sha256(token)[:12]> derivation Setup.vue pre-fills the subdomain with (must mirror the CLI).
watch(pending, async (target) => {
    if (target === undefined || target.role !== `owner`) {
        cleanupCommand.value = undefined;
        return;
    }
    let slug: string;
    if (target.daemonUrl !== null) {
        slug = new URL(target.daemonUrl).hostname.split(`.`)[0] ?? ``;
    } else {
        const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(target.token));
        const hex = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, `0`))
            .join(``);
        slug = sandboxSubdomain(hex.slice(0, 12));
    }
    cleanupCommand.value = bashCommand(`cleanup`, ``, `${slug} -y`);
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
    <!-- The rail's top control: a live chip for the active sandbox (initial + online status), click to switch. -->
    <button
        type="button"
        class="sandbox-switcher relative flex items-center justify-center overflow-hidden rounded-lg border border-line transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
        :class="route.path.startsWith('/sandbox') ? 'bg-primary-600/15 text-link' : 'bg-card text-muted'"
        aria-label="Switch sandbox"
        v-tooltip.right="sandbox.active.value?.name ?? 'Sandboxes'"
        @click="panel?.toggle($event)"
    >
        <img v-if="sandbox.active.value?.image" :src="sandbox.active.value.image" alt="" class="h-full w-full object-cover" />
        <span v-else-if="sandbox.active.value?.name" class="text-base font-semibold uppercase text-content">{{
            sandbox.active.value.name.charAt(0)
        }}</span>
        <Icon name="server" v-else class="text-lg" />
        <span
            class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card"
            :class="sandbox.reachable.value ? 'bg-success' : 'bg-subtle'"
        ></span>
    </button>

    <Popover ref="panel" append-to="body">
        <div class="flex w-64 flex-col gap-0.5 p-1">
            <div class="px-2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-subtle">Sandboxes</div>

            <button
                v-for="option in sandbox.sandboxes.value"
                :key="option.id"
                type="button"
                class="group flex items-center gap-2.5 rounded-md px-2 py-1 text-left text-sm transition-colors"
                :class="option.id === sandbox.activeSandboxId.value ? 'bg-primary-600/15' : 'hover:bg-content/5'"
                @click="pick(option.id)"
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
                <span v-if="option.role === 'member'" class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle"
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
                @click="openSandbox"
            >
                <span class="flex h-6 w-6 shrink-0 items-center justify-center">
                    <Icon name="cog" class="text-base text-muted" />
                </span>
                Sandbox settings
            </button>
        </div>
    </Popover>

    <Dialog
        :visible="pending !== undefined"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: '26rem' }"
        :header="pending?.role === 'owner' ? 'Remove from account?' : 'Leave sandbox?'"
        @update:visible="pending = undefined"
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
            <Code class="mt-2" :code="cleanupCommand" lang="bash" label="Cleanup command" :wrap="true" />
        </template>
        <template #footer>
            <Button label="Cancel" severity="secondary" :text="true" @click="pending = undefined" />
            <Button :label="pending?.role === 'owner' ? 'Remove' : 'Leave'" severity="danger" autofocus @click="confirmRemove">
                <template #icon><Icon name="trash" /></template>
            </Button>
        </template>
    </Dialog>
</template>

<style scoped>
.sandbox-switcher {
    width: var(--icon-rail-tile-size, 2.75rem);
    height: var(--icon-rail-tile-size, 2.75rem);
}
</style>
