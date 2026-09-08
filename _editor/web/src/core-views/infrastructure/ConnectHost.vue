<script setup lang="ts">
import { ui, Code, commandLang, InfoHint, OS_OPTIONS, SegmentedControl, useOsPreference } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import { useInventory } from "../../features/extensions/useInventory";
import { useSandbox } from "../../features/sandbox/client/useSandbox";
import { bashCommand, psCommand } from "../../app/environments/scriptCommand";
import ScriptSourceSwitch from "../../features/capabilities/connect/ScriptSourceSwitch.vue";
import { zoneFromUrl } from "@intentic/sandbox-contract";
import { normalizeHostName } from "./hostName";

// Shared connect-a-server flow, shown as InfraDeclare's requirement card and behind its Add-server button.
// One command sets up the host and self-registers via /enroll; no sandbox recreate, no keys pasted here.
// Always carries the user's own Cloudflare token: intentic's tunnels carry web traffic only.
const { refetch } = useInventory();
const { active, daemonUrl } = useSandbox();

// SANDBOX_URL, CONNECT_TOKEN, CF_TOKEN and ZONE when known; url/token come from the active sandbox.
const cfToken = ref(``);
const hostName = ref(``);
// Lenient check (Cloudflare tokens are [A-Za-z0-9_-]); the connect-host script does the real verify.
const cfTokenValid = computed(() => /^[A-Za-z0-9_-]{30,}$/.test(cfToken.value.trim()));
const cfTokenTouched = ref(false);
const hostNameTouched = ref(false);
const rawHostName = computed(() => hostName.value.trim());
const canonicalHostName = computed(() => normalizeHostName(hostName.value));
const hostNameReady = computed(() => rawHostName.value === `` || canonicalHostName.value !== ``);
// Derived from the daemon URL, only on the user's own domain; else the host resolves its own zone.
const zone = computed(() => (active.value?.providedAddress === true ? undefined : zoneFromUrl(daemonUrl.value)));

const commandReady = computed(() => {
    if (active.value === undefined) {
        return false;
    }
    return cfTokenValid.value && hostNameReady.value;
});
const lockedReason = computed(() => {
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
    const zoneEnv = zone.value !== undefined ? ` ZONE='${zone.value}'` : ``;
    const nameEnv = canonicalHostName.value !== `` ? ` HOST_NAME='${canonicalHostName.value}'` : ``;
    return bashCommand(
        `hostSh`,
        `sudo env SANDBOX_URL='${url}' CONNECT_TOKEN='${sandbox.token}' CF_TOKEN='${cfToken.value.trim()}'${zoneEnv}${nameEnv} `,
        ``,
    );
});

// PowerShell equivalent: same reactive inputs as the bash command, via connect-host.ps1. Stands up a
// Docker-in-Docker host container, since Windows can't be a native SSH+Docker target.
const connectHostCommandPs = computed(() => {
    const sandbox = active.value;
    const url = daemonUrl.value;
    if (sandbox === undefined || url === undefined) {
        return ``;
    }
    const base = `$env:SANDBOX_URL='${url}'; $env:CONNECT_TOKEN='${sandbox.token}'; `;
    const zoneEnv = zone.value !== undefined ? `$env:ZONE='${zone.value}'; ` : ``;
    const nameEnv = canonicalHostName.value !== `` ? `$env:HOST_NAME='${canonicalHostName.value}'; ` : ``;
    return psCommand(`hostPs1`, `${base}$env:CF_TOKEN='${cfToken.value.trim()}'; ${zoneEnv}${nameEnv}`);
});

// While the section is open, poll the inventory so a machine that just ran connect-host appears in the list.
const timer = setInterval(() => void refetch(), 3000);
onUnmounted(() => clearInterval(timer));
</script>

<template>
    <div class="@container flex flex-col gap-3">
        <div>
            <div class="flex items-center gap-2">
                <h3 class="font-semibold text-content">Connect a server</h3>
                <InfoHint label="How connecting a machine works">
                    <span class="block text-sm font-medium text-content">Connect a machine</span>
                    <span class="mt-1 block text-xs text-muted">
                        Run the command on any host (the machine this sandbox runs on, or another). It creates a service user + SSH key + a Cloudflare
                        tunnel and registers the host with your sandbox. Run it on more machines to spread services across them.
                    </span>
                </InfoHint>
            </div>
            <p class="mt-0.5 text-xs text-muted">
                <!-- Placement-specific: the requirement cards say why a server is being asked for. -->
                <slot name="reason"></slot>
                One command, run on the target host as root. Cloudflare is set up as part of it.
            </p>
        </div>

        <form class="flex flex-col gap-3" @submit.prevent>
            <div class="grid gap-3 @lg:grid-cols-2">
                <label class="ui-field">
                    <span class="ui-field-label">Cloudflare API token</span>
                    <input
                        v-model="cfToken"
                        type="password"
                        autocomplete="off"
                        placeholder="Paste your Cloudflare API token"
                        :class="[ui.input(), cfTokenTouched && cfToken.trim().length > 0 && !cfTokenValid ? 'ui-field-error-box' : '']"
                        @blur="cfTokenTouched = true"
                    />
                    <span v-if="cfTokenTouched && cfToken.trim().length > 0 && !cfTokenValid" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        That doesn't look like a Cloudflare API token: double-check for copy/paste slips.
                    </span>
                    <span v-else class="text-2xs text-subtle"
                        >Zone:Read · DNS:Edit · Cloudflare Tunnel:Edit. Rides the command into your host, never to the platform.</span
                    >
                </label>
                <label class="ui-field">
                    <span class="ui-field-label">Host name (optional)</span>
                    <input
                        v-model="hostName"
                        placeholder="defaults to the machine's hostname"
                        :class="[ui.input(), hostNameTouched && rawHostName !== '' && canonicalHostName === '' ? 'ui-field-error-box' : '']"
                        @blur="hostNameTouched = true"
                    />
                    <span v-if="hostNameTouched && rawHostName !== '' && canonicalHostName === ''" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        Use lowercase letters, digits and hyphens only.
                    </span>
                    <span v-else-if="canonicalHostName !== ``" class="text-2xs text-success">
                        ✓ Saved in intent as <span class="font-mono">{{ canonicalHostName }}</span>
                    </span>
                    <span v-else class="text-2xs text-subtle">A short name for this machine in your intent.</span>
                </label>
            </div>

            <div v-if="!commandReady" class="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-2xs text-subtle">
                <Icon name="lock" />
                <span>{{ lockedReason }}</span>
            </div>
            <template v-else>
                <div class="flex flex-wrap items-center justify-between gap-2">
                    <SegmentedControl v-model="cmdOs" :options="OS_OPTIONS" />
                    <!--
                        The strongest case for the switch: this runs on a SERVER, which never has the developer's
                        checkout.
                    -->
                    <ScriptSourceSwitch />
                </div>
                <Code
                    :code="cmdOs === `windows` ? connectHostCommandPs : connectHostCommand"
                    :lang="commandLang(cmdOs)"
                    :label="
                        cmdOs === `windows`
                            ? `Run in PowerShell on the machine you want to deploy onto (needs Docker Desktop)`
                            : `Run on the machine you want to deploy onto (needs root)`
                    "
                    :wrap="true"
                />
            </template>

            <div v-if="commandReady" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="spinner" class="text-info" spin />
                <span
                    >Waiting for machines to register: each appears in your server list as you connect it. Re-run the command on each host you want to
                    add.</span
                >
            </div>
        </form>
    </div>
</template>
