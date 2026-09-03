<script setup lang="ts">
import { ui, Code, commandLang, InfoHint, OS_OPTIONS, SegmentedControl, useOsPreference } from "@intentic/ui";
import { computed, onUnmounted, ref } from "vue";
import { useInventory } from "../../composables/extensions/useInventory";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { bashCommand, psCommand } from "../../environments/scriptCommand";
import ScriptSourceSwitch from "../../components/ScriptSourceSwitch.vue";
import { zoneFromUrl } from "@intentic/sandbox-contract";
import { normalizeHostName } from "./hostName";

/* The single add-a-server flow: shown by InfraDeclare and the Add dialog as the requirement card when
 * something the user wants needs a deploy target (the parent unmounts it once a host registers), and by
 * InfraDeclare's "What you have" section behind its Add server button. Run a single connect-host
 * command on each host you want to deploy onto: it sets up the host (service user + SSH key + its own
 * Cloudflare tunnel) and self-registers with the sandbox via /enroll (authed by the connection token): no
 * sandbox recreate, no keys pasted here.
 *
 * The command carries the user's OWN Cloudflare token, always: a deploy target is reached over SSH, and
 * intentic's own tunnels carry web traffic only, so the platform has nothing to hand out here. This runs in the
 * browser workspace, so the sandbox self-context (daemon URL, connect token) comes from the platform's sandbox
 * registry (useSandbox); the install command from scriptCommand (deploy curls intentic.dev, dev runs the repo
 * script by path). */
const { refetch } = useInventory();
const { active, daemonUrl } = useSandbox();

// The connect-host one-liner: SANDBOX_URL (the daemon) + CONNECT_TOKEN (which also authorizes /enroll) +
// CF_TOKEN (entered here; the daemon writes it via /enroll), with ZONE when we know one. The command shape comes
// from scriptCommand (deploy vs local-dev-by-path); the sandbox URL + token from the active sandbox.
const cfToken = ref(``);
const hostName = ref(``);
// Lenient format check (Cloudflare tokens are 40 chars of [A-Za-z0-9_-]); the connect-host script does the real verify.
const cfTokenValid = computed(() => /^[A-Za-z0-9_-]{30,}$/.test(cfToken.value.trim()));
const cfTokenTouched = ref(false);
const hostNameTouched = ref(false);
const rawHostName = computed(() => hostName.value.trim());
const canonicalHostName = computed(() => normalizeHostName(hostName.value));
const hostNameReady = computed(() => rawHostName.value === `` || canonicalHostName.value !== ``);
/* The zone to create this host's tunnel in, derived client-side from the daemon URL: right when the sandbox is
 * behind the user's OWN domain (same account, same zone). A sandbox we connect answers under intentic's zone,
 * which the user's token cannot touch: pass no ZONE there and let the host resolve the token's own zone. */
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
                <!-- Placement-specific motivation (the requirement cards say why a server is being asked for). -->
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
                    <!-- The strongest case for the switch in the app: this command is run on a SERVER, which
                         never has the developer's checkout, so a dev build's repo-path form cannot work there. -->
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
