<script setup lang="ts">
import type { SandboxSummary, SetupCode, SetupCodeTarget } from "@intentic-app/api-contract";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { cmp, Code, CopyButton, InfoHint, Segmented, StepSection, useOsPreference } from "@intentic-app/ui";
import Button from "primevue/button";
import Select from "primevue/select";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ToggleSwitch from "primevue/toggleswitch";
import { track } from "../composables/analytics";
import { apiClient, isPaymentRequired } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";
import { useCloudflareZones } from "../composables/extensions/useCloudflareZones";
import { syncFolder } from "../composables/sandbox/syncFolder";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { environment } from "../environments/environment";
import { bashCommand, psCommand } from "../environments/scriptCommand";
import SetupCompose from "./SetupCompose.vue";
import type { ComposeArgs } from "./setupCompose";

/* The setup gate's destination (outside the workspace shell). Step 2 offers two ways to make the sandbox reachable:
 *   • intentic-provided (default): the platform provisions a Cloudflare tunnel under its OWN zone; the user needs no
 *     Cloudflare of their own. The subdomain is fixed (server-derived from the connection token).
 *   • own Cloudflare: the user pastes their token, picks a zone, and edits the subdomain; the sandbox creates its own
 *     tunnel. The token only reaches the platform for a request-scoped zone listing, then is dropped — on this path it
 *     rides the command as a CF_TOKEN env var, never stored.
 * Either way the platform mints a SHORT-LIVED SETUP CODE (sandbox.setupCode) for the chosen target; the copy-paste
 * command carries only that code and the connect script redeems it at POST /setup/claim for the real values — so no
 * raw token lands in shell history. Step 3 also offers desktop sync (on by default): the choice + folder ride the
 * same code (SYNC_DIR + a platform-minted single-use SYNC_PAIR_TOKEN in the payload), so the one pasted command
 * additionally enrolls the sync agent after the sandbox boots — no second paste. Once running, the DAEMON announces
 * its URL + liveness to the platform; this page just polls sandbox.list for a fresh lastSeenAt and then opens the
 * workspace — the browser never resolves the sandbox hostname here, so no DNS race can wedge setup. */

const sandbox = useSandbox();
const router = useRouter();
const route = useRoute();
const { upgradeOpen, entitlements, refreshPlan } = useAuth();

// The sandbox created in this setup session (holds its connection token). Null until the user names + creates it.
const created = ref<SandboxSummary | null>(null);
// True when we arrived via ?sandbox=<id> and resumed an existing sandbox (vs. created one here now).
const resuming = ref(false);
const name = ref(``);
const creating = ref(false);
const error = ref<string | null>(null);

// Whether the account is at its owned-sandbox cap — mirrors the server gate (router.ts) and the switcher
// preflight, so we upsell before the user names + creates a sandbox that would only 402.
const atLimit = computed(() => {
    const limit = entitlements.value?.sandboxLimit;
    return limit !== undefined && sandbox.sandboxes.value.filter((entry) => entry.role === `owner`).length >= limit;
});

// Step 2 mode. Default is the zero-config intentic-provided path; "own" is the bring-your-own-Cloudflare toggle.
const mode = ref<"intentic" | "own">(`intentic`);
// Whether the intentic-provided path is offered at all (false once its mint 404s — the server feature flag).
const intenticAvailable = ref(true);

// --- setup code state (both paths) ---
// The minted {code, hostname, expiresAt} for the currently chosen target; the command carries only the code.
const setup = ref<SetupCode | null>(null);
const setupError = ref<string | undefined>(undefined);
// The target key `setup` was minted for, so watcher re-fires don't re-mint and a stale mint is discarded.
const mintedFor = ref<string | undefined>(undefined);
let mintTimer: ReturnType<typeof setTimeout> | undefined;

// --- own-Cloudflare path state ---
// Token + zone discovery is shared with the in-app Connect Cloudflare step (useCloudflareZones). Here it only
// feeds the setup-code target — on this path the token rides the install command, it isn't written to .env.
const { cfToken, cfTokenValid, zones, selectedZone, zonesLoading, zonesError, setToken } = useCloudflareZones();
const showToken = ref(false);
// The editable subdomain prefix, pre-filled with the derived `sandbox-<hash>` default (so an untouched field
// reproduces the CLI's default). The full hostname is `<subdomain>.<selectedZone>`.
const subdomain = ref(``);
const derivedPrefix = ref(``);
const subdomainValid = computed(() => /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain.value.trim()));

// --- desktop sync opt-in (step 3) ---
// On by default: the same pasted command also enrolls the sync agent. The folder rides the command as a
// SYNC_DIR env var (a path, not a secret), so toggling this just adds/removes it — no re-mint. The folder is
// derived from the sandbox name (not user-editable) — shown as info, not a field.
const syncEnabled = ref(true);
const syncDir = computed(() => (created.value ? syncFolder(created.value.name, created.value.id) : ``));

// Step 1 collapses to a summary once the sandbox exists — its title carries the name.
const step1Title = computed(() => (resuming.value ? `Reconnect "${name.value}"` : created.value ? `Sandbox: ${name.value}` : `Name your sandbox`));

// Step 3 shows one command at a time; the preferred OS is a persisted singleton shared across screens.
const { cmdOs } = useOsPreference();

// The command is out and we're watching the registry for the daemon's announce — drives step 4's "waiting…".
const waiting = computed(() => setup.value !== null);

// The chosen target once its inputs are complete — what the setup code is minted for; undefined keeps it locked.
const target = computed<SetupCodeTarget | undefined>(() => {
    if (mode.value === `intentic`) {
        return { mode: `intentic` };
    }
    if (cfTokenValid.value && selectedZone.value !== undefined && subdomainValid.value) {
        return { mode: `own`, zone: selectedZone.value, subdomain: subdomain.value.trim() };
    }
    return undefined;
});
// Identity of the target, for mint dedupe + stale-response drops (a mint answers for the key it was fired for).
// The sandbox id is part of the key — a code redeems ONE sandbox's token, so switching sandboxes mid-page
// (resume → "create a new one instead") invalidates the previous mint instead of showing sandbox A's command
// for sandbox B. The sync choice is deliberately NOT part of this — it rides the command, not the code, so
// toggling it never re-mints.
const targetKey = computed<string | undefined>(() => {
    const chosen = target.value;
    if (chosen === undefined || created.value === null) {
        return undefined;
    }
    return `${created.value.id}:${chosen.mode === `intentic` ? `intentic` : `own:${chosen.zone}:${chosen.subdomain}`}`;
});

// The command can be built only once the chosen target has a code minted for it.
const commandReady = computed(() => setup.value !== null && mintedFor.value === targetKey.value);
const lockedReason = computed(() => {
    if (mode.value === `intentic`) {
        return setupError.value ?? `Preparing your intentic domain…`;
    }
    if (cfToken.value.length === 0) {
        return `Enter your Cloudflare API token to reveal your install command.`;
    }
    if (!cfTokenValid.value) {
        return `Your install command appears once the token above looks valid.`;
    }
    if (zonesLoading.value) {
        return `Checking which Cloudflare zones this token can use…`;
    }
    if (zonesError.value !== undefined) {
        return `Fix the Cloudflare token issue above to continue.`;
    }
    if (selectedZone.value === undefined) {
        return `Choose which Cloudflare zone to use to reveal your command.`;
    }
    if (!subdomainValid.value) {
        return `Enter a valid subdomain (letters, numbers, hyphens) to reveal your command.`;
    }
    return setupError.value ?? `Preparing your install command…`;
});

// LOCAL DEV ONLY: connect.{sh,ps1} redeems the setup code against PLATFORM_URL (host-side; the container never
// reads it), so when the platform is served locally we ride the localhost origin into the command. For the
// hosted platform this is undefined and the command is unchanged (the scripts default to api.intentic.dev).
const platformUrlOverride = computed<string | undefined>(() => {
    const api = new URL(environment.api.url);
    if (api.hostname !== `localhost` && api.hostname !== `127.0.0.1`) {
        return undefined;
    }
    return api.origin;
});

// oRPC surfaces a disabled endpoint as NOT_FOUND (404) — the signal that the intentic-provided path is off.
const isNotFound = (err: unknown): boolean => {
    if (err && typeof err === `object`) {
        const e = err as { code?: unknown; status?: unknown };
        return e.code === `NOT_FOUND` || e.status === 404;
    }
    return false;
};

// The daemon registers ONCE on boot, so lastSeenAt marks its last (re)start, not a live heartbeat — we can't
// use absolute freshness (a long-running sandbox's stamp is legitimately old). Instead we remember the stamp we
// started watching with and redirect when it ADVANCES: a daemon has (re)booted since the user got the command.
// Comparing two server timestamps to each other is also immune to browser clock skew.
const baseline = ref<string | null>(null);
watch(
    () => created.value?.id,
    () => {
        baseline.value = created.value?.lastSeenAt ?? null;
    },
    { immediate: true },
);

// Why we're still waiting (undefined while nothing informative to say) — step 4 shows it so a stuck wait names
// its cause instead of spinning silently.
const status = ref<string | undefined>(undefined);
// True while a registry check is in flight — gives "Check now" a visible checking state.
const checking = ref(false);

// Poll the platform registry for the daemon's boot registration (POST /sandbox/announce writes daemonUrl +
// lastSeenAt). When lastSeenAt advances past the baseline, a daemon has come up for this sandbox — open the
// workspace. Same-origin, no DNS resolution of the sandbox hostname.
const check = async (): Promise<void> => {
    if (created.value === null || checking.value) {
        return;
    }
    checking.value = true;
    try {
        await sandbox.refresh();
        // A reachable platform clears any earlier "can't reach" warning — it must not outlive its cause.
        status.value = undefined;
        const seen = sandbox.active.value?.lastSeenAt ?? null;
        if (seen !== null && seen !== baseline.value) {
            // Onboarding's make-or-break milestone: the pasted command produced a live daemon.
            track(`sandbox_connected`, { resuming: resuming.value });
            await router.push(`/`);
        }
    } catch {
        status.value = `Can't reach the platform to check — retrying…`;
    } finally {
        checking.value = false;
    }
};

// Create a new sandbox (mints its connection token) and make it active. Entry point of the flow — the mint
// watcher below takes over the moment `created` holds a sandbox.
const createSandbox = async (): Promise<void> => {
    if (name.value.trim() === `` || creating.value) {
        return;
    }
    creating.value = true;
    error.value = null;
    try {
        created.value = await sandbox.create(name.value.trim());
    } catch (err) {
        // A plan-gate hit (free limit reached) opens the Upgrade dialog; the gate's message still renders inline.
        if (isPaymentRequired(err)) {
            upgradeOpen.value = true;
        }
        error.value = errorMessage(err, `Could not create your sandbox.`);
    } finally {
        creating.value = false;
    }
};

// Mint the setup code for the chosen target (the intentic path provisions the tunnel + DNS server-side before
// returning, so the hostname it shows already exists). A NOT_FOUND on the intentic path means the feature is
// off: hide the option and fall back to own-Cloudflare. Responses for a stale target are dropped.
const mint = async (chosen: SetupCodeTarget, key: string): Promise<void> => {
    if (created.value === null) {
        return;
    }
    setupError.value = undefined;
    try {
        const minted = await apiClient.sandbox.setupCode({ sandboxId: created.value.id, target: chosen });
        if (key !== targetKey.value) {
            return;
        }
        setup.value = minted;
        mintedFor.value = key;
    } catch (err) {
        if (chosen.mode === `intentic` && isNotFound(err)) {
            intenticAvailable.value = false;
            mode.value = `own`;
        } else if (key === targetKey.value) {
            setupError.value = errorMessage(err, `Couldn't prepare your install command — try again.`);
        }
    }
};

// The locally-built sandbox image a dev sandbox runs. Without it, connect.sh pulls the published
// sandbox:stable, whose daemon predates any unreleased routes the dev web app calls — every new daemon
// endpoint would answer 404 until the next release. connect.sh's ensure_image never pulls a registry-less
// tag: it uses the local image, or builds it from the checkout the dev command runs the script from.
const DEV_SANDBOX_IMAGE = `intentic-sandbox:dev`;

// The shared env suffix each command carries: the local-dev PLATFORM_URL override (plus the shared dev
// agent-auth volume, so sandboxes created against a localhost platform keep their AI logins across resets,
// and the locally-built sandbox image so the daemon matches the working tree), and SYNC_DIR when desktop
// sync is opted in (a folder path, not a secret — the connect script runs the sync agent only when it's set).
const platformEnv = (): string =>
    platformUrlOverride.value
        ? ` PLATFORM_URL='${platformUrlOverride.value}' INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth' SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'`
        : ``;
const platformEnvPs = (): string =>
    platformUrlOverride.value
        ? `$env:PLATFORM_URL='${platformUrlOverride.value}'; $env:INTENTIC_AGENT_AUTH_VOLUME='intentic-dev-agent-auth'; $env:SANDBOX_IMAGE='${DEV_SANDBOX_IMAGE}'; `
        : ``;
const syncEnv = (): string => (syncEnabled.value ? ` SYNC_DIR='${syncDir.value}'` : ``);
const syncEnvPs = (): string => (syncEnabled.value ? `$env:SYNC_DIR='${syncDir.value}'; ` : ``);

// The commands carry only the short-lived setup code (redeemed by the script at /setup/claim) — plus, on the
// own-Cloudflare path, the CF token as an env var (never stored by the platform, so it can't ride the code).
const linuxCommand = (): string => {
    const code = setup.value?.code;
    if (code === undefined) {
        return ``;
    }
    const envs = `${mode.value === `own` ? ` CF_TOKEN='${cfToken.value.trim()}'` : ``}${platformEnv()}${syncEnv()}`;
    return bashCommand(`sh`, `sudo${envs === `` ? `` : ` env${envs}`} `, code);
};

const windowsCommand = (): string => {
    const code = setup.value?.code;
    if (code === undefined) {
        return ``;
    }
    const cfEnv = mode.value === `own` ? `$env:CF_TOKEN='${cfToken.value.trim()}'; ` : ``;
    return psCommand(`ps1`, `${platformEnvPs()}${cfEnv}${syncEnvPs()}$env:SETUP_CODE='${code}'; `);
};

const selectedCommand = computed(() => (cmdOs.value === `windows` ? windowsCommand() : linuxCommand()));
const selectedCommandLang = computed(() => (cmdOs.value === `windows` ? `powershell` : `bash`));

// The third Run tab: manage the sandbox with the user's own docker-compose.yml instead of the install
// script. Local state layered over the persisted OS preference — picking Compose must not overwrite the
// unix/windows choice other screens share (CommandOs stays a two-value type).
const composeSelected = ref(false);
const runTab = computed<`unix` | `windows` | `compose`>({
    get: () => (composeSelected.value ? `compose` : cmdOs.value),
    set: (value) => {
        composeSelected.value = value === `compose`;
        if (value !== `compose`) {
            cmdOs.value = value;
        }
    },
});
const composeArgs = computed<ComposeArgs | undefined>(() => {
    if (setup.value === null) {
        return undefined;
    }
    return {
        mode: mode.value,
        code: setup.value.code,
        hostname: setup.value.hostname,
        ...(mode.value === `own` ? { cfToken: cfToken.value.trim() } : {}),
        // Compose has NO build step and is deployed to a host that must PULL the image — so it always
        // references the published registry image, never the local `:dev` tag connect.sh rebuilds from the
        // checkout (a local-only tag can't be pulled and won't exist on a deploy target). The rendered file
        // gets pull_policy: always, tracking the moving `:stable` release.
        image: `registry.gitlab.com/radarsu/intentic/sandbox:stable`,
        googleClientId: environment.auth.googleClientId,
        ...(platformUrlOverride.value ? { platformUrl: platformUrlOverride.value } : {}),
    };
});

// When the gate's "Open setup" carried a sandbox id, resume setup for that sandbox (name + steps 2-4) instead
// of a blank create form. Owned only — a member can't mint someone else's sandbox, so their id falls through
// to create. The check loop acts on the ACTIVE sandbox, so select it to make the URL self-contained.
onMounted(async () => {
    void refreshPlan(); // so atLimit is accurate even on a direct navigation to /setup
    const loaded = await sandbox.list();
    const requested = route.query[`sandbox`];
    const found = typeof requested === `string` ? loaded.find((entry) => entry.id === requested) : undefined;
    if (found?.role !== `owner`) {
        return;
    }
    sandbox.select(found.id);
    name.value = found.name;
    created.value = found;
    resuming.value = true;
});

// Escape hatch from a resumed setup: forget the resumed sandbox and drop to a blank create form. Everything
// derived from the resumed sandbox resets too — its minted code, hostname, and token-derived subdomain must
// not leak into the sandbox created next.
const startFresh = (): void => {
    resuming.value = false;
    created.value = null;
    name.value = ``;
    error.value = null;
    setup.value = null;
    mintedFor.value = undefined;
    setupError.value = undefined;
    subdomain.value = ``;
    derivedPrefix.value = ``;
    void router.replace({ path: `/setup` }); // drop ?sandbox= so a reload doesn't re-resume
};

// Watch the registry while we sit on /setup; the moment the daemon reports in, open the workspace.
const timer = setInterval(() => void check(), 3000);
onUnmounted(() => {
    clearInterval(timer);
    clearTimeout(mintTimer);
});

// Mint the setup code whenever the chosen target is complete, debounced so subdomain/folder keystrokes don't
// each mint a code. Re-minting overwrites the previous code server-side. targetKey already carries the
// sandbox id, so a resume→create-new switch re-fires this on its own.
watch(
    targetKey,
    () => {
        clearTimeout(mintTimer);
        const chosen = target.value;
        const key = targetKey.value;
        if (chosen === undefined || key === undefined || created.value === null || mintedFor.value === key) {
            return;
        }
        mintTimer = setTimeout(() => void mint(chosen, key), 500);
    },
    { immediate: true },
);

// Derive the default `sandbox-<hash>` prefix (must mirror the CLI) once the connection token is known, and
// pre-fill the editable subdomain field if the user hasn't typed one.
watch(
    () => created.value?.token,
    async (token) => {
        if (token === undefined) {
            return;
        }
        const digest = await crypto.subtle.digest(`SHA-256`, new TextEncoder().encode(token));
        const hex = Array.from(new Uint8Array(digest))
            .map((b) => b.toString(16).padStart(2, `0`))
            .join(``);
        derivedPrefix.value = sandboxSubdomain(hex.slice(0, 12));
        if (subdomain.value === ``) {
            subdomain.value = derivedPrefix.value;
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="min-h-screen w-full overflow-auto bg-canvas text-content">
        <div class="animate-fade-in mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
            <header class="flex items-center gap-3">
                <span
                    class="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-primary-600/30 bg-linear-to-br from-primary-600/20 to-primary-600/5 shadow-md"
                    aria-label="intentic platform"
                >
                    <img src="/assets/intentic-logo-sized.png" alt="intentic" class="h-6 w-6 object-contain" />
                </span>
                <div>
                    <h1 class="text-2xl font-semibold">Set up your workspace</h1>
                    <p class="text-sm text-muted">
                        A few minutes to a live sandbox — no Cloudflare account required. Use intentic's domain, or bring your own.
                    </p>
                </div>
                <!-- Escape hatch for a returning user: they already own a sandbox, so /'s requireSetup guard
                     lets them back into the workspace. Hidden for a new user (0 sandboxes) who'd just bounce back. -->
                <Button
                    v-if="sandbox.sandboxes.value.length > 0"
                    label="Back to workspace"
                    severity="secondary"
                    :text="true"
                    class="ml-auto shrink-0"
                    @click="void router.push(`/`)"
                >
                    <template #icon><Icon name="arrow-left" /></template>
                </Button>
            </header>

            <!-- Step 1: name + create the sandbox (collapses to a summary once created). -->
            <StepSection :step="1" :done="created !== null" :title="step1Title">
                <template v-if="created === null">
                    <!-- At the plan cap: upsell here instead of a name form whose Create can only 402. -->
                    <template v-if="atLimit">
                        <p class="text-xs text-muted">
                            You're on the Free plan, which includes one sandbox — and it's already in use. Upgrade to Pro to run more.
                        </p>
                        <Button label="Upgrade to Pro" class="self-start" @click="upgradeOpen = true">
                            <template #icon><Icon name="star" /></template>
                        </Button>
                    </template>
                    <template v-else>
                        <p class="text-xs text-muted">Give this sandbox a name so you can tell it apart in the switcher — you can run several.</p>
                        <div class="flex items-center gap-2">
                            <input
                                v-model="name"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="e.g. work, staging, my-laptop"
                                :class="cmp.input('w-full font-mono')"
                                @keydown.enter="createSandbox"
                            />
                            <Button label="Create" :loading="creating" :disabled="name.trim().length === 0" @click="createSandbox">
                                <template #icon><Icon name="plus" /></template>
                            </Button>
                        </div>
                        <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>
                    </template>
                </template>
                <template v-else-if="resuming">
                    <p class="text-xs text-muted">
                        This sandbox still exists on the platform — the CLI cleanup only cleared its local container. Reconnect it below to start a
                        fresh daemon<template v-if="!atLimit">, or create a new sandbox instead</template>.
                    </p>
                    <!-- Free-at-limit: the honest alternative is upgrading, not a create form that 402s. -->
                    <button
                        v-if="atLimit"
                        type="button"
                        class="self-start text-xs text-muted underline hover:text-content"
                        @click="upgradeOpen = true"
                    >
                        Need another sandbox? Upgrade to Pro
                    </button>
                    <button v-else type="button" class="self-start text-xs text-muted underline hover:text-content" @click="startFresh">
                        Not this one? Create a new sandbox instead
                    </button>
                </template>
            </StepSection>

            <!-- Step 2: how to reach the sandbox (intentic domain collapses to a summary; own-CF form on demand). -->
            <StepSection v-if="created" :step="2" :done="setup !== null" title="How should we reach your sandbox?">
                <!-- Intentic-provided: fixed, read-only domain. -->
                <template v-if="mode === `intentic`">
                    <div v-if="setupError" :class="cmp.alertDanger('text-2xs')">
                        {{ setupError }}
                    </div>
                    <template v-else-if="setup">
                        <div class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2 font-mono text-sm text-content">
                            <Icon name="lock" class="text-subtle" />
                            <span>{{ setup.hostname }}</span>
                        </div>
                        <button type="button" class="self-start text-xs text-link hover:underline" @click="mode = `own`">
                            Use my own domain instead
                        </button>
                    </template>
                    <p v-else class="text-xs text-muted"><Icon name="spinner" spin /> Preparing your intentic domain…</p>
                </template>

                <!-- Own Cloudflare: token + zone + editable subdomain. -->
                <template v-else>
                    <button v-if="intenticAvailable" type="button" class="self-start text-xs text-link hover:underline" @click="mode = `intentic`">
                        ← Use intentic's domain
                    </button>
                    <div class="flex items-center gap-2.5">
                        <h3 class="text-sm font-semibold text-content">Cloudflare API token</h3>
                        <InfoHint class="ml-auto" label="Why the Cloudflare API token is required">
                            <p class="mb-1 text-sm font-semibold text-content">Why this token?</p>
                            <p class="mb-3 text-2xs leading-relaxed text-muted">
                                intentic reaches your sandbox over a private Cloudflare tunnel — no open inbound ports.
                            </p>
                            <ul class="flex flex-col gap-2 text-2xs text-muted">
                                <li class="flex items-start gap-2">
                                    <Icon name="bolt" class="mt-0.5 text-link" />
                                    <span>Lets the install command <span class="text-content">create the tunnel</span></span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <Icon name="lock" class="mt-0.5 text-success" />
                                    <span
                                        ><span class="text-content">Never stored by intentic</span> — used once to list zones, then rides the
                                        command</span
                                    >
                                </li>
                            </ul>
                        </InfoHint>
                    </div>
                    <label class="ui-field">
                        <span class="ui-field-label">API token</span>
                        <div class="flex items-center gap-2">
                            <input
                                :type="showToken ? 'text' : 'password'"
                                :value="cfToken"
                                @input="setToken(($event.target as HTMLInputElement).value)"
                                autocomplete="off"
                                autocapitalize="off"
                                spellcheck="false"
                                placeholder="Paste your Cloudflare API token"
                                :class="cmp.input('w-full font-mono')"
                            />
                            <Button
                                severity="secondary"
                                :text="true"
                                @click="showToken = !showToken"
                                :aria-label="showToken ? 'Hide token' : 'Show token'"
                            >
                                <template #icon><Icon :name="showToken ? 'eye-slash' : 'eye'" /></template>
                            </Button>
                        </div>
                    </label>
                    <p v-if="cfToken.length === 0" class="text-xs text-muted">
                        Used once to look up your Cloudflare zones, then it rides the command into your sandbox — intentic never stores it.
                    </p>
                    <p v-else-if="!cfTokenValid" class="text-xs text-warning">
                        That doesn't look like a Cloudflare API token — double-check for copy/paste slips.
                    </p>
                    <p v-else-if="zonesLoading" class="text-xs text-muted">
                        <Icon name="spinner" spin /> Checking which Cloudflare zones this token can use…
                    </p>
                    <div v-else-if="zonesError" :class="cmp.alertDanger('text-2xs')">
                        {{ zonesError }}
                    </div>
                    <label v-else-if="zones.length > 1" class="ui-field">
                        <span class="ui-field-label">Cloudflare zone</span>
                        <Select v-model="selectedZone" :options="zones" placeholder="Pick the domain to use" />
                        <span class="text-xs text-muted">This token can reach several domains — choose which one your sandbox should use.</span>
                    </label>

                    <!-- Editable domain: the subdomain prefix under the chosen zone. -->
                    <label v-if="selectedZone" class="ui-field">
                        <span class="ui-field-label">Domain</span>
                        <div class="flex items-center gap-2">
                            <input
                                :value="subdomain"
                                @input="subdomain = ($event.target as HTMLInputElement).value"
                                autocomplete="off"
                                autocapitalize="off"
                                spellcheck="false"
                                placeholder="sandbox"
                                :class="cmp.input('w-full font-mono')"
                            />
                            <span class="whitespace-nowrap font-mono text-sm text-subtle">.{{ selectedZone }}</span>
                        </div>
                        <span v-if="!subdomainValid" class="text-xs text-warning">Use letters, numbers and hyphens only.</span>
                        <span v-else class="text-xs text-success"
                            >✓ Your sandbox will be reachable at <span class="font-mono">{{ subdomain.trim() }}.{{ selectedZone }}</span
                            >.</span
                        >
                    </label>

                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs">
                        <a
                            href="https://dash.cloudflare.com/profile/api-tokens"
                            target="_blank"
                            rel="noreferrer"
                            class="inline-flex items-center gap-1 text-link hover:underline"
                        >
                            Create a token <Icon name="external-link" />
                        </a>
                        <span class="text-subtle">Scopes: Zone:Read · DNS:Edit · Cloudflare Tunnel:Edit</span>
                    </div>
                </template>
            </StepSection>

            <!-- Step 3: run the sandbox. -->
            <StepSection v-if="created" :step="3" title="Run your sandbox">
                <template #actions>
                    <InfoHint label="What running your sandbox does" text="What this does">
                        <p class="mb-1 text-sm font-semibold text-content">What this does</p>
                        <p class="mb-3 text-2xs leading-relaxed text-muted">One command on the machine that will host your sandbox. It:</p>
                        <ul class="flex flex-col gap-2 text-2xs text-muted">
                            <li class="flex items-start gap-2">
                                <Icon name="box" class="mt-0.5 text-link" />
                                <span>Starts your sandbox in <span class="text-content">Docker</span></span>
                            </li>
                            <li class="flex items-start gap-2">
                                <Icon name="cloud" class="mt-0.5 text-link" />
                                <span>Opens a <span class="text-content">private Cloudflare tunnel</span> so your browser can reach it</span>
                            </li>
                            <li class="flex items-start gap-2">
                                <Icon name="lock" class="mt-0.5 text-success" />
                                <span>No open ports, <span class="text-content">nothing deployed</span> — just a reachable workspace</span>
                            </li>
                        </ul>
                        <div class="mt-3 border-t border-line pt-2 text-2xs text-subtle">
                            <p>Docker Engine on Linux, Docker Desktop on macOS/Windows — a first Windows install may need a reboot.</p>
                            <a
                                href="https://docs.docker.com/get-docker/"
                                target="_blank"
                                rel="noreferrer"
                                class="mt-1 inline-flex items-center gap-1 text-link hover:underline"
                            >
                                Or install Docker yourself <Icon name="external-link" />
                            </a>
                        </div>
                    </InfoHint>
                </template>

                <p class="flex items-center gap-2 text-xs text-muted">
                    <Icon name="box" class="text-info" />
                    Needs Docker — installed automatically if missing (you'll be asked first).
                </p>

                <!-- Desktop sync opt-in: the same command also installs the sync agent. Toggling just adds/removes
                     the SYNC_DIR env on the command below — no re-mint. The folder is derived from the name. -->
                <div class="flex items-center gap-3 rounded-xl border border-line bg-canvas p-4">
                    <ToggleSwitch v-model="syncEnabled" class="shrink-0" aria-label="Also sync a local folder with this sandbox" />
                    <div class="flex flex-col gap-0.5">
                        <span class="text-sm font-semibold text-content">Also sync a local folder with this sandbox</span>
                        <span class="text-xs text-muted">
                            <template v-if="syncEnabled"
                                >Mirrors to <code>{{ syncDir }}</code> so you can use your own editor.</template
                            >
                            <template v-else>Mirror a local folder here so you can use your own editor.</template>
                        </span>
                    </div>
                </div>
                <!-- The command carries the chosen path's values, so we don't reveal it until that path is ready — a
                     command missing the token/zone/subdomain or the provisioned tunnel would just fail in the sandbox. -->
                <div v-if="!commandReady" class="flex items-center gap-2 rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted">
                    <Icon name="lock" />
                    <span>{{ lockedReason }}</span>
                </div>
                <template v-else>
                    <div class="flex flex-col gap-2">
                        <div class="flex flex-wrap items-center justify-between gap-2">
                            <Segmented
                                v-model="runTab"
                                :options="[
                                    { label: `Linux / macOS`, value: `unix` },
                                    { label: `Windows (PowerShell)`, value: `windows` },
                                    { label: `Docker Compose`, value: `compose` },
                                ]"
                            />
                            <CopyButton v-if="runTab !== `compose`" :text="selectedCommand" label="Copy" />
                        </div>
                        <SetupCompose v-if="runTab === `compose` && composeArgs" :args="composeArgs" :sync-enabled="syncEnabled" />
                        <template v-else>
                            <Code :code="selectedCommand" :lang="selectedCommandLang" :wrap="true" :copyable="false" />
                            <!-- Local dev only: platformEnv() injects SANDBOX_IMAGE=intentic-sandbox:dev — connect.sh
                                 rebuilds it from this checkout on every run (layer-cached), so the pasted command is
                                 self-sufficient and never runs a stale image after sandbox edits. -->
                            <p v-if="platformUrlOverride" class="flex items-center gap-2 text-xs text-warning">
                                <Icon name="box" class="shrink-0" />
                                <span
                                    >Local dev: this command builds <code>{{ DEV_SANDBOX_IMAGE }}</code> from your checkout and
                                    runs it — every run rebuilds, so sandbox edits are always picked up (cached when unchanged;
                                    the first build takes a few minutes). For a live edit loop, keep
                                    <code>pnpm dev:sandbox</code> running.</span
                                >
                            </p>
                        </template>
                    </div>
                </template>
            </StepSection>

            <!-- Step 4: live gate — waits for the daemon to report in to the platform (no browser→sandbox calls). -->
            <StepSection v-if="created" :step="4" :title="waiting ? `Waiting for your sandbox to report in…` : `Connect your sandbox`">
                <template #actions>
                    <Icon name="spinner" v-if="waiting" class="text-info" spin />
                    <Button label="Check now" size="small" severity="secondary" :text="true" :loading="checking" @click="check">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                </template>
                <p class="text-xs text-muted">
                    <template v-if="waiting"
                        >Your sandbox announces itself the moment it starts — your workspace opens automatically when it does.</template
                    >
                    <template v-else>After you run the command above, your sandbox reports in and your workspace opens automatically.</template>
                </p>
                <p v-if="status" class="text-2xs text-warning">{{ status }}</p>
            </StepSection>
        </div>
    </div>
</template>
