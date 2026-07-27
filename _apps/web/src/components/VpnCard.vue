<script setup lang="ts">
import { cmp, Row, RowGroup, StatusBadge, type StatusVariant } from "@intentic-app/ui";
import type { VpnLink } from "@intentic/sandbox-contract";
import Button from "primevue/button";
import { computed, reactive, ref } from "vue";
import { errorMessage } from "../composables/useAsyncAction";
import { useVpn } from "../composables/sandbox/useVpn";

/* The sandbox's VPN tunnels: what is carrying traffic right now, and the connect/disconnect controls for it.
 * This is the answer to "is the sandbox on the VPN, and which one" — the assigned address and the routed
 * networks, not just a green dot, because "connected" alone doesn't tell you whether your internal host is
 * actually reachable through it.
 *
 * The agent drives the very same daemon routes through its `vpn` command, so a tunnel it dialled appears here
 * without anything having to synchronise the two. */

const { links, connect, disconnect, error: listError } = useVpn();

// Per-tunnel local UI state: the in-flight action, the last streamed line, and any error — keyed by id so one
// failing tunnel never blanks another's row.
const busy = reactive(new Set<string>());
const progress = reactive<Record<string, string>>({});
const failures = reactive<Record<string, string>>({});
// The tunnel whose one-time-code field is open, and its current value. A code is never stored — it goes
// straight into the dial and is cleared afterwards.
const otpFor = ref<string>();
const otp = ref(``);

const variantOf = (link: VpnLink): StatusVariant =>
    link.state === `connected` ? `success` : link.state === `failed` ? `danger` : link.state === `connecting` ? `warning` : `neutral`;

const PROVIDER_LABEL: Record<VpnLink["provider"], string> = {
    wireguard: `WireGuard`,
    fortinet: `FortiGate SSL-VPN`,
    ipsec: `IPsec`,
};

// "14m" / "3h 20m" / "2d 4h" — an uptime read at a glance.
const ago = (since: number | undefined): string | undefined => {
    if (since === undefined) {
        return undefined;
    }
    const minutes = Math.max(0, Math.round((Date.now() - since) / 60000));
    if (minutes < 60) {
        return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

// The facts that answer "what does this tunnel actually carry" — full-tunnel is called out by name, because
// "0.0.0.0/0" is the single most consequential thing a connected VPN can be doing to the sandbox.
const factsOf = (link: VpnLink): string[] =>
    [
        link.address,
        link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.length > 0 ? link.routes.join(`, `) : undefined,
        link.interface,
        ago(link.since),
    ].filter((fact): fact is string => fact !== undefined && fact !== ``);

const run = async (id: string, action: () => Promise<void>): Promise<void> => {
    busy.add(id);
    delete failures[id];
    try {
        await action();
    } catch (caught) {
        failures[id] = errorMessage(caught, `The VPN action failed.`);
    } finally {
        busy.delete(id);
        delete progress[id];
    }
};

const onConnect = async (link: VpnLink): Promise<void> => {
    const code = otpFor.value === link.id ? otp.value.trim() : ``;
    await run(link.id, () =>
        connect(link.id, code === `` ? undefined : code, (message) => {
            progress[link.id] = message;
        }),
    );
    otpFor.value = undefined;
    otp.value = ``;
};

const onDisconnect = (link: VpnLink): Promise<void> => run(link.id, () => disconnect(link.id));

// A gateway that wants a token says so in the failure — offer the code field right where the user just failed
// rather than making them guess that a retry needs one.
const wantsCode = (id: string): boolean => /one-time code|2FA|token/i.test(failures[id] ?? ``);

const anyConnected = computed(() => links.value.some((link) => link.state === `connected`));
</script>

<template>
    <RowGroup label="VPN">
        <div v-if="listError" :class="cmp.alertDanger('m-4')">{{ listError }}</div>
        <div v-else-if="links.length === 0" class="px-4 py-6 text-center text-xs text-muted">
            No VPN configured.
            <RouterLink to="/capabilities/vpn" class="text-link hover:underline">Add one</RouterLink>
            to put this sandbox on a private network.
        </div>
        <template v-else>
            <Row v-for="link in links" :key="link.id" :icon="link.state === 'connected' ? 'shield' : 'globe'">
                <template #title>
                    {{ link.id }}
                    <span class="ml-2 text-2xs font-normal text-subtle">{{ PROVIDER_LABEL[link.provider] }}</span>
                    <span v-if="link.gateway" class="ml-1 font-mono text-2xs font-normal text-subtle">{{ link.gateway }}</span>
                </template>
                <template #description>
                    <span v-if="factsOf(link).length > 0" class="font-mono">{{ factsOf(link).join(" · ") }}</span>
                    <span v-else-if="link.state === 'unavailable'">
                        Needs a sandbox rebuild to install its client —
                        <RouterLink to="/sandbox/environment" class="text-link hover:underline">finish setup →</RouterLink>
                    </span>
                    <span v-else-if="link.autoConnect">Connects automatically after a sandbox restart.</span>
                </template>
                <template #control>
                    <div class="flex items-center gap-2">
                        <StatusBadge :variant="variantOf(link)" :label="link.state" size="xs" dot v-tooltip.top="link.detail" />
                        <Button
                            v-if="link.state === 'connected' || link.state === 'connecting'"
                            label="Disconnect"
                            size="small"
                            :text="true"
                            :loading="busy.has(link.id)"
                            @click="onDisconnect(link)"
                        />
                        <Button
                            v-else
                            label="Connect"
                            size="small"
                            :text="true"
                            :disabled="link.state === 'unavailable'"
                            :loading="busy.has(link.id)"
                            @click="onConnect(link)"
                        />
                    </div>
                </template>
                <template v-if="progress[link.id] || failures[link.id] || otpFor === link.id" #below>
                    <div class="mt-2 flex flex-col gap-2">
                        <p v-if="progress[link.id]" class="font-mono text-2xs text-subtle">{{ progress[link.id] }}</p>
                        <!-- The client's own words: a rejected password, or the exact --servercert digest to pin.
                             Preserved verbatim and wrapped, because that digest is unusable if it's truncated. -->
                        <pre
                            v-if="failures[link.id]"
                            class="scrollbar-thin max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-danger/40 bg-danger/10 px-3 py-2 font-mono text-2xs text-danger"
                            >{{ failures[link.id] }}</pre>
                        <div v-if="otpFor === link.id" class="flex items-center gap-2">
                            <input
                                v-model="otp"
                                :class="cmp.input('w-32 font-mono')"
                                placeholder="123456"
                                inputmode="numeric"
                                autocomplete="one-time-code"
                                @keyup.enter="onConnect(link)"
                            />
                            <Button label="Connect with code" size="small" :loading="busy.has(link.id)" @click="onConnect(link)" />
                            <Button label="Cancel" size="small" severity="secondary" :text="true" @click="otpFor = undefined" />
                        </div>
                        <button
                            v-else-if="wantsCode(link.id)"
                            type="button"
                            class="inline-flex w-fit items-center gap-1 text-2xs text-link hover:underline"
                            @click="
                                otpFor = link.id;
                                otp = ``;
                            "
                        >
                            <Icon name="key" /> Enter a one-time code
                        </button>
                    </div>
                </template>
            </Row>
            <!-- The consequence worth stating once, under the list rather than per row: while a full-tunnel VPN
                 is up, everything the sandbox does — agent turns, git, package installs — leaves through it. -->
            <div v-if="anyConnected" class="px-4 pb-3 text-2xs text-muted">
                Traffic matching a connected tunnel's routes leaves the sandbox through it — including the agent's.
            </div>
        </template>
    </RowGroup>
</template>
