<script setup lang="ts">
import { HostTunnelSchema, type HostTunnel } from "@intentic-app/api-contract";
import { Card, cmp, Code, InfoHint, Segmented, useOsPreference } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, onUnmounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandboxClient";
import { useInventory } from "../../composables/extensions/useInventory";
import { useSandbox } from "../../composables/useSandbox";
import { environment } from "../../environments/environment";
import { zoneFromUrl } from "@intentic/sandbox-contract";
import { normalizeHostName } from "./hostName";

/* The connect-a-server requirement card, shown by InfraDeclare when something the user wants needs a deploy
 * target and none is connected yet (it unmounts itself once a host registers). Run a single connect-host
 * command on each host you want to deploy onto — it sets up the host (service user + SSH key + its own
 * Cloudflare tunnel) and self-registers with the sandbox via /enroll (authed by the connection token) — no
 * sandbox recreate, no keys pasted here. On an own-Cloudflare sandbox the command carries the user's CF token;
 * on an intentic-provided one the daemon relays a host-tunnel mint to the platform and the command carries its
 * connector token instead — no Cloudflare account needed. This runs in the browser workspace, so the sandbox
 * self-context (daemon URL, connect token, tunnel provenance) comes from the platform's sandbox registry
 * (useSandbox); the script URLs from the web environment; the zone is derived client-side from the daemon URL. */
const { refetch } = useInventory();
const { active, daemonUrl } = useSandbox();


// Whether this sandbox's tunnel is intentic-provided (platform-computed: no user Cloudflare token). On that path
// host tunnels are minted platform-side (relayed by the daemon) and the one-liner carries the narrow connector
// token instead of CF_TOKEN.
const provided = computed(() => active.value?.providedTunnel === true);

// The connect-host one-liner: SANDBOX_URL (the daemon) + CONNECT_TOKEN (which also authorizes /enroll) + either
// CF_TOKEN (entered here; the daemon writes it via /enroll) with ZONE, or — on the intentic-provided path — the
// minted HOST_SSH_TUNNEL_TOKEN/HOST_SSH_HOSTNAME with the required HOST_NAME that salted the mint. Script URLs
// come from the web environment; the sandbox URL + token from the active sandbox.
const cfToken = ref(``);
const hostName = ref(``);
// Lenient format check (Cloudflare tokens are 40 chars of [A-Za-z0-9_-]); the connect-host script does the real verify.
const cfTokenValid = computed(() => /^[A-Za-z0-9_-]{30,}$/.test(cfToken.value.trim()));
const cfTokenTouched = ref(false);
const hostNameTouched = ref(false);
const rawHostName = computed(() => hostName.value.trim());
const canonicalHostName = computed(() => normalizeHostName(hostName.value));
const hostNameReady = computed(() => rawHostName.value === `` || canonicalHostName.value !== ``);
// The zone the sandbox tunnel already lives under (derived client-side from the daemon URL); undefined when unknown.
const zone = computed(() => zoneFromUrl(daemonUrl.value));

// The minted intentic-provided host tunnel, valid for exactly the host name it was minted with — the name salts
// the tunnel id, so editing it voids the command and needs a new mint (re-minting the same name reuses the tunnel).
const minted = ref<HostTunnel | undefined>(undefined);
const mintedName = ref(``);
const minting = ref(false);
const mintError = ref<string | undefined>(undefined);
const mintCurrent = computed(() => minted.value !== undefined && mintedName.value === canonicalHostName.value);
const canMint = computed(() => canonicalHostName.value !== `` && active.value !== undefined);

const mint = async (): Promise<void> => {
    const name = canonicalHostName.value;
    // Only the intentic-provided path mints; on the own-Cloudflare path the command is reactive, so a form
    // Enter must be a no-op here rather than minting a host tunnel the user never asked for.
    if (!provided.value || !canMint.value || minting.value) {
        return;
    }
    minting.value = true;
    mintError.value = undefined;
    try {
        minted.value = HostTunnelSchema.parse(
            await sandboxJson(`/system/host-tunnel`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ hostName: name }),
                // The floor that guarantees this promise settles (and the spinner stops) even when every hop
                // upstream stalls. Longer than the daemon's platform-relay timeout, so its specific error wins.
                signal: AbortSignal.timeout(90_000),
            }),
        );
        mintedName.value = name;
    } catch (err) {
        mintError.value =
            err instanceof DOMException && err.name === `TimeoutError`
                ? `Timed out preparing this host's tunnel — try again.`
                : err instanceof Error && err.message.length > 0
                  ? err.message
                  : `Couldn't prepare this host's tunnel — try again.`;
    } finally {
        minting.value = false;
    }
};

const commandReady = computed(() => {
    if (active.value === undefined) {
        return false;
    }
    if (provided.value) {
        return mintCurrent.value;
    }
    return cfTokenValid.value && hostNameReady.value && zone.value !== undefined;
});
const lockedReason = computed(() => {
    if (provided.value) {
        if (hostName.value.trim() === ``) {
            return `Enter a host name to generate this machine's command.`;
        }
        return `Generate the command for this host name.`;
    }
    if (cfToken.value.trim().length === 0) {
        return `Enter your Cloudflare API token to reveal the command.`;
    }
    if (!cfTokenValid.value) {
        return `The command appears once the token above looks valid.`;
    }
    if (!hostNameReady.value) {
        return `Enter a host name to generate this machine's command.`;
    }
    return `Preparing your command…`;
});
// One command at a time; the preferred OS is a persisted singleton shared across screens.
const { cmdOs } = useOsPreference();

const connectHostCommand = computed(() => {
    const sandbox = active.value;
    const url = daemonUrl.value;
    if (sandbox === undefined || url === undefined) {
        return ``;
    }
    if (provided.value) {
        if (minted.value === undefined || !mintCurrent.value) {
            return ``;
        }
        return `curl -fsSL ${environment.scriptUrls.hostSh} | sudo env SANDBOX_URL='${url}' CONNECT_TOKEN='${sandbox.token}' HOST_SSH_TUNNEL_TOKEN='${minted.value.tunnelToken}' HOST_SSH_HOSTNAME='${minted.value.hostname}' HOST_NAME='${mintedName.value}' sh`;
    }
    if (zone.value === undefined) {
        return ``;
    }
    const nameEnv = canonicalHostName.value !== `` ? ` HOST_NAME='${canonicalHostName.value}'` : ``;
    return `curl -fsSL ${environment.scriptUrls.hostSh} | sudo env SANDBOX_URL='${url}' CONNECT_TOKEN='${sandbox.token}' CF_TOKEN='${cfToken.value.trim()}' ZONE='${zone.value}'${nameEnv} sh`;
});

// The PowerShell equivalent (Windows deploy target). Same reactive inputs as the bash one-liner above, but the
// connect-host.ps1 form: `$env:X='…'; … irm <hostPs1> | iex`. The script stands up a Docker-in-Docker host
// container on the machine (Windows can't be a native SSH+Docker target).
const connectHostCommandPs = computed(() => {
    const sandbox = active.value;
    const url = daemonUrl.value;
    if (sandbox === undefined || url === undefined) {
        return ``;
    }
    const base = `$env:SANDBOX_URL='${url}'; $env:CONNECT_TOKEN='${sandbox.token}'; `;
    if (provided.value) {
        if (minted.value === undefined || !mintCurrent.value) {
            return ``;
        }
        return `${base}$env:HOST_SSH_TUNNEL_TOKEN='${minted.value.tunnelToken}'; $env:HOST_SSH_HOSTNAME='${minted.value.hostname}'; $env:HOST_NAME='${mintedName.value}'; irm ${environment.scriptUrls.hostPs1} | iex`;
    }
    if (zone.value === undefined) {
        return ``;
    }
    const nameEnv = canonicalHostName.value !== `` ? `$env:HOST_NAME='${canonicalHostName.value}'; ` : ``;
    return `${base}$env:CF_TOKEN='${cfToken.value.trim()}'; $env:ZONE='${zone.value}'; ${nameEnv}irm ${environment.scriptUrls.hostPs1} | iex`;
});

// While the section is open, poll the inventory so a machine that just ran connect-host appears in the list.
const timer = setInterval(() => void refetch(), 3000);
onUnmounted(() => clearInterval(timer));
</script>

<template>
    <Card class="flex flex-col gap-3">
        <div class="flex items-start gap-2.5">
            <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                    <h3 class="font-semibold text-content">Connect a server</h3>
                    <InfoHint label="How connecting a machine works">
                        <span class="block text-sm font-medium text-content">Connect a machine</span>
                        <span class="mt-1 block text-xs text-muted">
                            Run the command on any host (the machine this sandbox runs on, or another). It creates a service user + SSH key + a
                            Cloudflare tunnel and registers the host with your sandbox. Run it on more machines to spread services across them.
                        </span>
                    </InfoHint>
                </div>
                <p class="mt-0.5 text-xs text-muted">
                    What you want needs a server to run on.
                    {{
                        provided
                            ? `One command per machine, run on it as root. No Cloudflare account needed — intentic hosts the tunnel.`
                            : `One command, run on the target host as root. Cloudflare is set up as part of it.`
                    }}
                </p>
            </div>
        </div>

        <form class="flex flex-col gap-3" @submit.prevent="mint">
            <div class="grid gap-3 sm:grid-cols-2">
                <label v-if="!provided" class="ui-field">
                    <span class="ui-field-label">Cloudflare API token</span>
                    <input
                        v-model="cfToken"
                        type="password"
                        autocomplete="off"
                        placeholder="Paste your Cloudflare API token"
                        :class="[cmp.input(), cfTokenTouched && cfToken.trim().length > 0 && !cfTokenValid ? 'ui-field-input-error' : '']"
                        @blur="cfTokenTouched = true"
                    />
                    <span v-if="cfTokenTouched && cfToken.trim().length > 0 && !cfTokenValid" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        That doesn’t look like a Cloudflare API token — double-check for copy/paste slips.
                    </span>
                    <span v-else class="text-2xs text-subtle"
                        >Zone:Read · DNS:Edit · Cloudflare Tunnel:Edit. Rides the command into your host, never to the platform.</span
                    >
                </label>
                <label class="ui-field">
                    <span class="ui-field-label">{{ provided ? `Host name` : `Host name (optional)` }}</span>
                    <input
                        v-model="hostName"
                        :placeholder="provided ? `e.g. home-server` : `defaults to the machine's hostname`"
                        :class="[cmp.input(), hostNameTouched && rawHostName !== '' && canonicalHostName === '' ? 'ui-field-input-error' : '']"
                        @blur="hostNameTouched = true"
                    />
                    <span v-if="hostNameTouched && rawHostName !== '' && canonicalHostName === ''" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        Use lowercase letters, digits and hyphens only.
                    </span>
                    <span v-else-if="canonicalHostName !== ``" class="text-2xs text-success">
                        ✓ Saved in intent as <span class="font-mono">{{ canonicalHostName }}</span>
                    </span>
                    <span v-else class="text-2xs text-subtle">{{
                        provided
                            ? `A short name for this machine — each name gets its own intentic-hosted tunnel.`
                            : `A short name for this machine in your intent.`
                    }}</span>
                </label>
            </div>

            <div v-if="!commandReady" class="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-2xs text-subtle">
                <Icon name="lock" />
                <span>{{ lockedReason }}</span>
            </div>
            <template v-else>
                <Segmented
                    v-model="cmdOs"
                    :options="[
                        { label: `Linux / macOS`, value: `unix` },
                        { label: `Windows (PowerShell)`, value: `windows` },
                    ]"
                />
                <Code
                    :code="cmdOs === `windows` ? connectHostCommandPs : connectHostCommand"
                    :lang="cmdOs === `windows` ? `powershell` : `bash`"
                    :label="
                        cmdOs === `windows`
                            ? `Run in PowerShell on the machine you want to deploy onto (needs Docker Desktop)`
                            : `Run on the machine you want to deploy onto (needs root)`
                    "
                    :wrap="true"
                />
            </template>

            <Button
                v-if="provided && !commandReady"
                type="submit"
                class="self-start"
                label="Generate command"
                :loading="minting"
                :disabled="!canMint || minting"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
            <p v-if="mintError !== undefined" :class="cmp.alertDanger()">
                {{ mintError }}
            </p>

            <div v-if="commandReady" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="spinner" class="text-info" spin />
                <span>{{
                    provided
                        ? `Waiting for machines to register — they appear above as you connect them. Generate a separate command for each host name you want to add.`
                        : `Waiting for machines to register — they appear above as you connect them. Re-run the command on each host you want to add.`
                }}</span>
            </div>
        </form>
    </Card>
</template>
