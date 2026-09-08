<script setup lang="ts">
import type { Device } from "@intentic/sandbox-contract";
import { Button, Code, type DeviceSandboxGroup, Icon, sandboxGroups } from "@intentic/ui";
import { computed, ref } from "vue";
import { RouterLink } from "vue-router";
import { apiClient } from "../../../lib/useApi";
import { containerNotices } from "../overview/containerHealth";
import { manageDeviceSandbox, useDevices } from "./useDevices";
import { useSandbox } from "../client/useSandbox";
import { useRole } from "../secrets/useRole";

/* WHAT THIS SANDBOX CANNOT DO AND WILL NOT FIX BY ITSELF, on the one screen that can do something about it.
 *
 * The evidence is all pre-existing (containerHealth.ts reads it, and says why it was invisible until now). This
 * component is the OTHER half: a fault whose repair needs a computer belongs beside the computers, and this tab
 * is already where a sandbox is started, updated, rolled back and reshaped from.
 *
 * WHY THE REPAIR IS ONE CLICK AND NOT A DIALOG. Every other verb on this page replaces the container too, and
 * this one is the mildest of them: same slug, same volumes, a container swapped for one that has what it was
 * missing — `ic sandbox connect`'s own comments call a same-slug re-run a normal reset, and it removes the
 * container, never /work. A confirmation here would be asking somebody to approve something safer than the
 * Update button sitting a few rows below it, which teaches people to click through dialogs rather than read
 * them. What the card owes them instead is saying plainly, before the click, what survives it.
 *
 * WHEN THERE IS NO BUTTON. The repair runs on the machine that HOSTS the sandbox, through an agent that has to
 * be connected. Absent that, the card degrades to the same repair by hand — the setup screen, which mints the
 * same claim for somebody to paste — rather than hiding, because the diagnosis is worth reading either way. */

const { active, daemonUrl } = useSandbox();
const { isOwner } = useRole();
const { devices } = useDevices({ poll: false });

const notices = computed(() => (active.value === undefined ? [] : containerNotices(active.value)));

// This sandbox's container slug, derived exactly as the page around it does (the daemon's own hostname).
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

/* The connected machine that runs THIS sandbox, which is the only one a reconnect may be aimed at: the claim
 * names one sandbox, and redeeming it anywhere else would build a second container rather than repair this one.
 * Both sides must be known, for the reason `isSelf` states next door — two optionals comparing equal would let
 * an unknown-URL sandbox adopt the first machine in the list. */
const host = computed<Device | undefined>(() =>
    ownSlug.value === undefined
        ? undefined
        : devices.value.find(
              (device) =>
                  device.hostId !== undefined &&
                  device.report !== undefined &&
                  sandboxGroups(device.report.pairings, device.report.ports, device.report.sandboxes).some(
                      (group: DeviceSandboxGroup) => group.sandbox?.slug === ownSlug.value,
                  ),
          ),
);

// Minting a claim is the owner's act (the platform gates it there too); a member sees the diagnosis and the
// sentence naming who can act, never a button that would 403 on them.
const canRepair = computed(() => isOwner.value && host.value !== undefined && ownSlug.value !== undefined);

const busy = ref(false);
const failure = ref<string | undefined>(undefined);
const done = ref<string | undefined>(undefined);
const lines = ref<string[]>([]);

const repair = async (): Promise<void> => {
    const device = host.value;
    const slug = ownSlug.value;
    const sandboxId = active.value?.id;
    if (busy.value || device?.hostId === undefined || slug === undefined || sandboxId === undefined) {
        return;
    }
    busy.value = true;
    failure.value = undefined;
    done.value = undefined;
    lines.value = [];
    try {
        /* Minted HERE rather than reused: every mint re-signs the grant, so the claim this sends is current by
         * construction and there is no stale code to reason about. The browser holds it for the length of one
         * call — the same code the setup screen would have shown somebody to paste. */
        const { code } = await apiClient.sandbox.setupCode({ sandboxId });
        done.value = await manageDeviceSandbox(device.hostId, slug, `reconnect`, {
            setupCode: code,
            onLine: (line) => (lines.value = [...lines.value, line]),
        });
    } catch (error) {
        /* The sandbox this browser is talking to is the one being replaced, so the stream is EXPECTED to die
         * mid-flight — the daemon carrying it goes down with the container. That is the successful shape, not a
         * failure, and reporting it as one would send people to look for a problem that isn't there. The
         * container comes back on its own; the page reconnects when it does. */
        failure.value = error instanceof Error ? error.message : String(error);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <section v-if="notices.length > 0" class="flex flex-col gap-3 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3">
        <div v-for="notice of notices" :key="notice.fault" class="flex flex-col gap-2">
            <div class="flex items-start gap-2">
                <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
                <div class="flex min-w-0 flex-col gap-1">
                    <p class="text-sm font-medium text-content">{{ notice.title }}</p>
                    <p class="text-xs text-muted">{{ notice.detail }}</p>
                    <!--
                        The env by name, for a bug report or a `docker inspect` — evidence a reader may skip, so it
                        sits under the sentence that does not need it.
                    -->
                    <p v-if="notice.keys?.length" class="flex flex-wrap items-center gap-1 text-xs text-muted">
                        <span>Missing from this container:</span>
                        <Code v-for="key of notice.keys" :key="key" :code="key" />
                    </p>
                    <p v-if="notice.repair" class="text-xs text-muted">{{ notice.repair }}</p>
                </div>
            </div>

            <div class="flex flex-wrap items-center gap-2 pl-6">
                <!-- Named for what it does to the container, not for the fault: "Repair" hides that this replaces it. -->
                <Button
                    v-if="canRepair"
                    size="small"
                    severity="secondary"
                    :loading="busy"
                    :disabled="busy"
                    :label="busy ? `Reconnecting…` : `Reconnect this sandbox`"
                    @click="repair"
                />
                <!-- The same repair by hand, and the only one available to a member or with no machine connected. -->
                <Button
                    v-else
                    :as="RouterLink"
                    :to="{ path: `/setup`, query: { sandbox: active?.id } }"
                    size="small"
                    severity="secondary"
                    :text="true"
                    label="Open its setup screen"
                >
                    <template #icon><Icon name="arrow-up-right" /></template>
                </Button>
                <p v-if="canRepair" class="text-xs text-muted">
                    Replaces the container on {{ host?.label ?? `this machine` }}. Its files, its history and its Docker engine are kept.
                </p>
                <p v-else-if="!isOwner" class="text-xs text-muted">Only this sandbox's owner can reconnect it.</p>
                <p v-else class="text-xs text-muted">Connect the computer that runs this sandbox to repair it from here.</p>
            </div>
        </div>

        <!-- The machine's own narration, verbatim; a reconnect takes a while and prints as it goes. -->
        <pre v-if="lines.length > 0" class="max-h-40 overflow-auto rounded border border-line-subtle p-2 text-xs text-muted">{{
            lines.join(`\n`)
        }}</pre>
        <p v-if="done" class="text-xs text-content">{{ done }}</p>
        <p v-if="failure" class="text-xs text-danger">
            {{ failure }}
            <!--
                Said next to the error rather than instead of it: this call cuts its own connection by design, so
                "it failed" and "it worked" look identical from here until the sandbox answers again.
            -->
            <span class="text-muted">If the sandbox was replaced, this page reconnects on its own once it is back.</span>
        </p>
    </section>
</template>
