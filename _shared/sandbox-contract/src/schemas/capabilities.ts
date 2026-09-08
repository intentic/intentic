// The one `{ id, kind, config }` shape every sandbox connection is written as: the config arm per kind, the union over
// them, and what the Capabilities page reads (status, probe, connect/rename/sign-in inputs).
import { z } from "zod";
import { ExitConfigSchema } from "./exit.js";
import { entryId } from "./internal.js";
import { ServiceKindSchema } from "./inventory.js";
import { VpnConfigSchema } from "./vpn.js";
// Everything a user adds is a capability with an idempotent apply plus a status check; the manifest is the source of
// truth for what's active, and `mcp`-kind entries also feed the agent's MCP servers each turn.

export const CapabilityKindSchema = z.enum([
    "devops",
    "monorepo",
    "mcp",
    "service",
    "integration",
    "cli",
    "plugin",
    "extension",
    "ssh",
    "vpn",
    "exit",
    "docker",
    "browser",
    "identity",
    "host",
    "webext",
    "agent",
    "endpoint",
    "localmodel",
    "wallet",
]);
export type CapabilityKind = z.infer<typeof CapabilityKindSchema>;
export const CapabilityStateSchema = z.enum(["active", "pending", "error", "inactive"]);
export type CapabilityState = z.infer<typeof CapabilityStateSchema>;
// Per-kind config. Secrets (an mcp token) live here and are denylisted like tools.json.
export const McpConfigSchema = z.object({
    url: z.url().describe("Where the tool server answers."),
    token: z.string().optional().describe("The credential it needs, if any. Stored, never echoed back."),
});
export const ServiceConfigSchema = z.object({
    service: ServiceKindSchema.describe("Which service to provision."),
    domain: z.string().min(1).describe("The address it should answer on."),
    on: z.string().min(1).describe("Which machine to put it on."),
    expose: z.string().min(1).describe("How it should be reachable."),
});
// External-app credential injected into deployed apps (i.have.stripe → STRIPE_API_KEY), not agent-facing like `cli`.
// Closed, unlike `cli`: it becomes an `i.have.<provider>` deploy.config.ts entry, so the vocabulary belongs to the
// deploy engine, not an extension.
export const IntegrationConfigSchema = z.object({
    provider: z.literal("stripe").describe("Which outside service's credential to make available to deployed apps."),
});
// Gives the agent an authenticated CLI tool: credential plus any non-secret URL, injected into the agent's env each
// turn, taught via an .agents/skills/<id> cheatsheet. Provider fields are data in an extension's
// `contributes.capabilities`, validated at add-time, not by this schema.
export const CliConfigSchema = z
    .object({
        provider: z
            .string()
            .min(1)
            .describe(
                "Which tool to give the agent. The rest of the fields are whatever that tool's own card declares it needs, and are checked against it when you connect.",
            ),
    })
    .catchall(z.string());
// A Claude Code plugin from a git repo; the daemon only owns the checkout, the Agent SDK's plugin loader reads its
// internals. `path` is a subdirectory for a plugin inside a larger checkout; `token` is https auth for a private repo.
export const PluginConfigSchema = z.object({
    url: z.url().describe("The repository to take the plugin from."),
    // Branch / tag / commit sha to pin; absent = the default branch's HEAD.
    ref: z.string().min(1).optional().describe("A branch, tag or commit to pin to. Leave it out to follow the default branch."),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional()
        .describe("Where inside the repository the plugin lives, for one that sits in a larger checkout."),
    token: z.string().min(1).optional().describe("A credential for a private repository. Stored, never echoed back."),
});
// An intentic extension from a git repo (UI bundle + agent contributions + processes). Unlike `plugin`, `ref` must be a
// full commit sha, since extension code runs trusted in the owner's browser and every update is a deliberate re-add at
// a new sha.
export const ExtensionConfigSchema = z.object({
    url: z.url().describe("The repository to take the extension from."),
    ref: z
        .string()
        .regex(/^[0-9a-f]{40}$/, "ref must be a full 40-character commit sha")
        .describe(
            "The exact commit to install, in full. Required rather than optional because extension code runs with your browser's trust: the owner approves precisely the code that runs, and an update is a deliberate re-install at a new commit.",
        ),
    path: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "path must stay inside the checkout" })
        .optional()
        .describe("Where inside the repository the extension lives, for one that sits in a larger checkout."),
    token: z.string().min(1).optional().describe("A credential for a private repository. Stored, never echoed back."),
    // What update checks and advisories are read against; absent falls back to the official registry.
    registry: z
        .url()
        .optional()
        .describe(
            "Which registry this install came from, which is what update checks and security advisories are read against. Absent falls back to the official one.",
        ),
});
// A remote machine the agent reaches over SSH; one capability per machine, the id is its ssh-config Host alias. Writes
// a config block and a 0600 key/password file, unlike `cli`, so nothing is injected into the agent's env and machines
// never collide.
export const SshConfigSchema = z.discriminatedUnion("auth", [
    z.object({
        auth: z.literal("key").describe("Sign in with a key."),
        host: z.string().min(1).describe("The machine's address."),
        port: z.coerce.number().default(22).describe("Which port it listens on."),
        user: z.string().min(1).describe("Which user to connect as."),
        privateKey: z.string().min(1).describe("The private key, whole. Stored with tight permissions and never echoed back."),
    }),
    z.object({
        auth: z.literal("password").describe("Sign in with a password."),
        host: z.string().min(1).describe("The machine's address."),
        port: z.coerce.number().default(22).describe("Which port it listens on."),
        user: z.string().min(1).describe("Which user to connect as."),
        password: z.string().min(1).describe("The password. Stored, never echoed back."),
    }),
]);
// What is optional about the in-sandbox Docker Engine: `gpu` is an IMAGE option (rides the Dockerfile overlay, needs a
// rebuild), everything else is an ENGINE option (rewrites daemon.json, restarts dockerd, no rebuild but stops running
// containers). Flat strings, not nested booleans, to match the manifest's own two-state convention.
export const DockerConfigSchema = z.object({
    gpu: z.enum(["on", "off"]).default("off"),
    // Pull-through cache/mirror; the nested engine starts with an empty image store, so the first compose up pulls
    // everything.
    registryMirror: z.url().optional(),
    // Registries reachable over plain http or a self-signed cert (a LAN or homelab registry); space- or
    // comma-separated.
    insecureRegistries: z.string().optional(),
    // One CIDR the nested engine carves container networks from; docker's default commonly collides with a corporate
    // VPN or LAN, silently routing some hosts into the bridge instead of the tunnel.
    addressPool: z.string().optional(),
});
// A logged-in browser session the agent drives via Playwright MCP, one capability per account (not per platform): the
// id keys the profile, login, passkey and tool prefix. `identity` shares another capability's browser and cookies (so
// its own `exit`/credentials are ignored); `purpose`/`openedAt` record why and when the agent opened it, since a site
// card declares no fields to carry that otherwise.
export const BrowserConfigSchema = z
    .object({
        platform: z.string().min(1),
        username: z.string().optional(),
        password: z.string().optional(),
        identity: z.string().optional(),
        purpose: z.string().optional(),
        // ISO-8601 date, stamped when the agent opens the account, absent for one connected by hand.
        openedAt: z.string().optional(),
        // The `exit` capability this profile browses from; ignored for an account born from an `identity`, since the
        // exit belongs to whoever owns the shared profile.
        exit: z.string().optional(),
    })
    .catchall(z.string());
// One email identity the sandbox acts as online: one persisted Chromium profile, signed in once by the owner, that
// every browser account naming it in `identity` shares. A capability, not a persona, since it holds live secrets (email
// password, profile identity) that must never be committed to git. `mailbox` feeds the code-reading tool;
// `openAccounts` is the explicit, off-by-default consent to sign up unattended.
export const IdentityConfigSchema = z.object({
    email: z.string().min(3),
    password: z.string().optional(),
    mailbox: z.string().optional(),
    loginUrl: z.url().optional(),
    openAccounts: z.enum(["on", "off"]).default("off"),
    // Sets browsing location for the whole shared profile at once; the only coherent place to set it, since every
    // account born from this identity shares one browser.
    exit: z.string().optional(),
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
// A connected device of the user's own, the inverse of `ssh`: it dials this daemon over one outbound WebSocket and
// serves an MCP tool surface the daemon tunnels, never implements. Scopes are the grant and are enforced on the
// machine, never here, so a compromised sandbox can't exceed what the owner ticked.
// on/off, not boolean: capability configs arrive from the form as strings, and a select renders an enum.
const hostScope = z.enum(["on", "off"]);
export const HostScopesSchema = z.object({
    // Run commands in a real shell (PowerShell on Windows, the login shell on Linux). Off ⇒ files/screen only.
    shell: hostScope.default("on"),
    // Create, modify and trash files under `roots`. Reads are always allowed within them; this is the write half.
    write: hostScope.default("off"),
    // Capture the screen. Off ⇒ screenshot refuses, and the agent is told so rather than getting a black frame.
    screen: hostScope.default("on"),
    // Its own switch, not part of `screen`: looking and touching are different permissions. Default off, like `write`.
    control: hostScope.default("off"),
    // Narrower than `shell`: named fleet operations, so an agent can supervise sandboxes without a shell at all.
    sandboxes: hostScope.default("off"),
    // Separate from `sandboxes`: everything that grants is reversible by doing it again, removal is undone by nothing.
    sandboxRemove: hostScope.default("off"),
    // Its own switch under `shell`, default off while `shell` defaults on: a laptop has no disposable image to recreate
    // from.
    destructive: hostScope.default("off"),
    // One directory per line. Empty ⇒ the machine's home directory, which is what the agent reports at connect.
    roots: z.string().optional(),
});
export type HostScopes = z.infer<typeof HostScopesSchema>;
export const HostConfigSchema = HostScopesSchema.extend({ platform: z.string().min(1) });
// The user's own browser, reached through their installed extension; the sibling of `host`, not an arm of it, since
// it's already signed in as the person, with their passkeys and SSO. Which sites the agent may touch lives in Chrome's
// own host permissions, not here; every switch is enforced in the extension, never checked on this side.
const webextScope = z.enum(["on", "off"]);
export const WebExtScopesSchema = z.object({
    // The floor of usefulness, defaults on; off, the connection is inert and the card says so.
    read: webextScope.default("on"),
    // On by default, unlike a device's `control`: driving the page is what this connector is for, not a last resort.
    act: webextScope.default("on"),
    // Off by default: the one read nothing here bounds, since it captures whatever pixels the window shows, not just
    // granted frames.
    screenshot: webextScope.default("off"),
    // Off by default: the only switch here that copies a credential rather than borrowing the browser holding it.
    cookies: webextScope.default("off"),
    // "sensitive" (default) prompts only for a password, payment or delete action; "always" prompts every action,
    // "never" trusts the owner to watch.
    confirm: z.enum(["sensitive", "always", "never"]).default("sensitive"),
});
export type WebExtScopes = z.infer<typeof WebExtScopesSchema>;
// An open slug (chrome, firefox), like a host's `platform`: a new browser family needs no daemon release.
export const WebExtConfigSchema = WebExtScopesSchema.extend({ platform: z.string().min(1) });
export type WebExtConfig = z.infer<typeof WebExtConfigSchema>;
// An ACP agent served as a chat provider: the daemon spawns `command` as a long-lived JSON-RPC subprocess, and the
// capability id becomes the provider id. `env` is a pasted KEY=VALUE block, the whole secret field; `loginCommand` runs
// an interactive device-code login in a visible terminal.
export const AcpAgentConfigSchema = z.object({
    command: z.string().min(1),
    name: z.string().min(1).optional(),
    env: z.string().optional(),
    loginCommand: z.string().min(1).optional(),
});
// A model API the user pointed us at: one shape for any server serving models over HTTP, local or remote, since they
// differ only in the URL. `protocol` is the real fork, about the wire, not location:
// openai: re-served through the bundled translator, since the harness speaks only Anthropic Messages
// anthropic: the harness is pointed straight at it with the user's own key
// `headers` is a pasted block for non-credential routing metadata (a tenant id); not the secret field, `apiKey` is.
export const EndpointProtocolSchema = z.enum(["openai", "anthropic"]);
export type EndpointProtocol = z.infer<typeof EndpointProtocolSchema>;
export const EndpointConfigSchema = z.object({
    // Taken verbatim, version segment included: guessing the suffix a server wants is how a working URL 404s.
    baseUrl: z.url(),
    protocol: EndpointProtocolSchema.default("openai"),
    apiKey: z.string().optional(),
    headers: z.string().optional(),
});
// A model the sandbox runs itself, the managed counterpart of `endpoint`: the daemon downloads the weights, serves them
// on a loopback llama-server, and registers an `endpoint/<id>` provider like a user-added one. `model` is a Hugging
// Face path (or "custom" for a direct GGUF `url`); `context`/`contextTokens` pick the served window, resolved to one
// token count in exactly one place so the server's flag and the card's promise never disagree.
export const LOCAL_MODEL_WINDOWS = ["16384", "32768", "65536", "131072"] as const;
export type LocalModelWindow = (typeof LOCAL_MODEL_WINDOWS)[number];
// 65,536: the smallest rung a full agent turn's own tool-schema overhead actually fits in (agent/context-budget.ts);
// the previous 32,768 default refused a model's first real message outright.
export const LOCAL_MODEL_WINDOW_DEFAULT: LocalModelWindow = "65536";
// Bounds against a typo, not a preference: below the floor no room is left after the loop's own overhead, above the
// ceiling no shipped GGUF was trained for it.
export const LOCAL_MODEL_WINDOW_MIN = 2048;
export const LOCAL_MODEL_WINDOW_MAX = 1_048_576;
export const LocalModelConfigSchema = z.object({
    model: z.string().min(1),
    gpu: z.enum(["on", "off"]).default("off"),
    url: z.url().optional(),
    context: z.union([z.enum(LOCAL_MODEL_WINDOWS), z.literal("custom")]).default(LOCAL_MODEL_WINDOW_DEFAULT),
    // Coerced from a text field's string, like the ssh card's `port`; read only when `context` is "custom".
    contextTokens: z.coerce.number().int().min(LOCAL_MODEL_WINDOW_MIN).max(LOCAL_MODEL_WINDOW_MAX).optional(),
});
export type LocalModelConfig = z.infer<typeof LocalModelConfigSchema>;
// The sandbox wallet: a USDC balance under owner policy, spent on x402-payable endpoints. The signing key lives with
// the platform, never the container; `address` is the wallet's public address, written back by apply, never typed.
// Policy defaults are conservative (every payment carded); amounts are decimal strings, never floats, since the daemon
// does arithmetic in atomic units.
const usdAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, "a USD amount like 0.50 (up to six decimals: USDC's own precision)");
export const WalletNetworkSchema = z.enum(["eip155:8453", "eip155:84532"]);
export type WalletNetwork = z.infer<typeof WalletNetworkSchema>;
export const WalletConfigSchema = z.object({
    // CAIP-2 chain id; Base mainnet, or Base Sepolia for a zero-real-money test mode.
    network: WalletNetworkSchema.default("eip155:8453"),
    // The wallet's public address, the platform's answer at apply time, never a form field.
    address: z.string().optional(),
    // Hard per-payment ceiling: over it the route refuses without raising a card.
    perPaymentMaxUsd: usdAmount.default("1.00"),
    // Payments at or under this settle without a card, inside the daily cap. "0" = every payment is carded.
    autoApproveUnderUsd: usdAmount.default("0"),
    // The UTC-day ceiling across all payments, carded or not.
    dailyCapUsd: usdAmount.default("5.00"),
    allow: z.string().optional(),
    deny: z.string().optional(),
});
export type WalletConfig = z.infer<typeof WalletConfigSchema>;
export type McpConfig = z.infer<typeof McpConfigSchema>;
export type ServiceConfig = z.infer<typeof ServiceConfigSchema>;
export type IntegrationConfig = z.infer<typeof IntegrationConfigSchema>;
export type CliConfig = z.infer<typeof CliConfigSchema>;
export type PluginConfig = z.infer<typeof PluginConfigSchema>;
export type ExtensionConfig = z.infer<typeof ExtensionConfigSchema>;
export type SshConfig = z.infer<typeof SshConfigSchema>;
export type DockerConfig = z.infer<typeof DockerConfigSchema>;
export type BrowserConfig = z.infer<typeof BrowserConfigSchema>;
export type HostConfig = z.infer<typeof HostConfigSchema>;
export type AcpAgentConfig = z.infer<typeof AcpAgentConfigSchema>;
export type EndpointConfig = z.infer<typeof EndpointConfigSchema>;
export const CapabilitySchema = z.discriminatedUnion("kind", [
    z.object({ id: entryId, kind: z.literal("devops"), config: z.object({}) }),
    // A pnpm+turbo monorepo the user scaffolds as its own repo, named by `id`; apps are added afterwards from its
    // operator panel.
    z.object({ id: entryId, kind: z.literal("monorepo"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("mcp"), config: McpConfigSchema }),
    z.object({ id: entryId, kind: z.literal("service"), config: ServiceConfigSchema }),
    z.object({ id: entryId, kind: z.literal("integration"), config: IntegrationConfigSchema }),
    z.object({ id: entryId, kind: z.literal("cli"), config: CliConfigSchema }),
    z.object({ id: entryId, kind: z.literal("plugin"), config: PluginConfigSchema }),
    z.object({ id: entryId, kind: z.literal("extension"), config: ExtensionConfigSchema }),
    z.object({ id: entryId, kind: z.literal("ssh"), config: SshConfigSchema }),
    // No IFNAMSIZ cap on the id: the tunnel interface name is derived, not the id itself, so a descriptive name is
    // free.
    z.object({ id: entryId, kind: z.literal("vpn"), config: VpnConfigSchema }),
    // A geo exit; deliberately not a vpn arm, since it routes nothing into the main table and carries no full-tunnel
    // warning.
    z.object({ id: entryId, kind: z.literal("exit"), config: ExitConfigSchema }),
    // The in-sandbox Docker Engine, baked into the image, dormant by default. No remove: de-privileging it silently
    // would be more destructive than useful given what runs on it.
    z.object({ id: entryId, kind: z.literal("docker"), config: DockerConfigSchema }),
    z.object({ id: entryId, kind: z.literal("browser"), config: BrowserConfigSchema }),
    // One email identity browser accounts are born from; they join it via their own `identity` field.
    z.object({ id: entryId, kind: z.literal("identity"), config: IdentityConfigSchema }),
    z.object({ id: entryId, kind: z.literal("host"), config: HostConfigSchema }),
    // The user's own browser, through their installed extension; `host`'s sibling, one capability per browser. Distinct
    // from `browser`, the sandbox's own Chromium profile: this one is the person's, already signed into everything,
    // only ever borrowed.
    z.object({ id: entryId, kind: z.literal("webext"), config: WebExtConfigSchema }),
    z.object({ id: entryId, kind: z.literal("agent"), config: AcpAgentConfigSchema }),
    // The id becomes `endpoint/<id>` in the chat picker, the `agent` kind's precedent, since these two are the only
    // kinds that mint providers.
    z.object({ id: entryId, kind: z.literal("endpoint"), config: EndpointConfigSchema }),
    // Deliberately mints the same `endpoint/<id>` ids as `endpoint`: to every consumer this is just an endpoint the
    // daemon happens to operate.
    z.object({ id: entryId, kind: z.literal("localmodel"), config: LocalModelConfigSchema }),
    // The sandbox's USDC wallet (WalletConfigSchema), one per sandbox; the key never enters the container.
    z.object({ id: entryId, kind: z.literal("wallet"), config: WalletConfigSchema }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;
// A credential the owner must type elsewhere (a WhatsApp pairing code); rendered large and copyable, not buried in
// `detail`'s sentence.
export const CapabilityStatusSchema = z.object({
    state: CapabilityStateSchema.describe("Whether it is live, still coming up, broken, or switched off."),
    detail: z.string().optional().describe("What is wrong, in words a person can act on."),
    code: z.string().optional().describe("A short marker for that reason, for anything deciding what to do about it."),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
// The list row: manifest entry plus live status, secrets never returned. `secrets` names which config keys hold a
// credential without carrying it, since `config` alone can't distinguish a blank field from one already holding a value
// the browser isn't shown.
export const CapabilitySummarySchema = z.object({
    id: z.string().describe("The connection's id."),
    kind: CapabilityKindSchema.describe("What sort of thing it is."),
    status: CapabilityStatusSchema.describe("Whether it is working."),
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("Its settings, minus anything secret."),
    // Defaulted for the daemon-older-than-browser seam: a required field would fail the whole list parse on an older
    // sandbox.
    secrets: z
        .array(z.string())
        .default([])
        .describe("Which credentials it holds, by name. The values are on one route only, and it is not this one."),
});
// A capability the workspace asks for but the manifest doesn't carry, derived from what's checked out under /work, not
// from configuration; prevents illegible failures like a missing docker socket with no pointer back to the fix. Keyed
// by catalog card, not kind, since several cards share one kind. Re-derived on every read, so it drops out once its
// evidence moves; `prefill` is never a secret, even one sitting in a checked-in file.
export const CapabilityRecommendationSchema = z.object({
    card: z.string().describe("Which connection is being suggested."),
    evidence: z
        .string()
        .describe("What was seen that prompted it: a file, a remote, printed verbatim so the claim can be checked rather than believed."),
    reason: z.string().describe("The same claim in words, without repeating the evidence into it."),
    prefill: z
        .record(z.string(), z.string())
        .describe(
            "Settings the scan could read, to fill the form so you supply only the credential. Never a secret, even when one is sitting in a checked-in file: the suggestion points at such a file, it does not absorb what is in it.",
        ),
});
export type CapabilityRecommendation = z.infer<typeof CapabilityRecommendationSchema>;
export const CapabilitiesListSchema = z.object({
    capabilities: z.array(CapabilitySummarySchema).describe("What this sandbox is connected to."),
    // Defaulted for the daemon-older-than-browser seam, so an older sandbox's parse doesn't fail just to hide a badge.
    recommendations: z
        .array(CapabilityRecommendationSchema)
        .default([])
        .describe(
            "Things worth connecting, worked out from what is actually in the workspace rather than from anything you configured. Re-derived on every read, so one whose evidence has moved simply stops being suggested.",
        ),
});
export const CapabilityIdParamSchema = z.object({ id: z.string().describe("Which connection.") });
// One capability's config verbatim, secrets included, for capabilities.connection; never served to a browser, since its
// handler accepts only daemon header grants, not a member identity.
export const CapabilityConnectionSchema = z.object({
    id: z.string().describe("The connection's id."),
    kind: z.string().describe("What sort of thing it is."),
    config: z
        .record(z.string(), z.string())
        .describe("Its settings exactly as stored, credentials included. The field names are its own kind's, which the caller already knows."),
});
export type CapabilityConnection = z.infer<typeof CapabilityConnectionSchema>;
// DELETE /capabilities/recommendations/{card}: the declined evidence is recorded daemon-side, so the suggestion returns
// once the workspace changes under it.
export const CapabilityCardParamSchema = z.object({ card: z.string().describe("Which suggestion to stop making.") });
// POST /capabilities/{id}/secret: replaces just the per-kind secret field and re-runs the capability's idempotent
// apply.
export const CapabilitySecretInputSchema = z.object({
    id: z.string().describe("Which connection."),
    value: z.string().min(1).describe("The new credential. Its other settings are left alone."),
});
// POST /capabilities/{id}/rename: a capability's id is the agent's handle for it (skill file, tool prefix, env suffix,
// ssh alias), so renaming is a migration, not a label edit. Which kinds may be renamed is the handler's own answer, not
// this schema's.
export const CapabilityRenameSchema = z.object({
    id: z.string(),
    to: z
        .string()
        .min(1)
        .max(60)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
});
// POST /capabilities/{id}/login: the tmux session running `loginCommand`, surfaced in the terminal panel to complete
// sign-in.
export const CapabilityLoginSchema = z.object({ session: z.string().describe("The terminal the sign-in is happening in. Attach to it to type.") });
// GET /capabilities/{id}/otp: a freshly minted TOTP code; the seed never crosses, `secondsRemaining` cues a re-mint
// rather than a stale submit.
export const CapabilityOtpSchema = z.object({
    code: z.string().describe("The code."),
    secondsRemaining: z
        .number()
        .describe("How long it lasts. Its expiring is what makes handing one to an agent safe, since the seed behind it is never revealed."),
});
// POST /capabilities/probe: did these settings actually reach the thing, asked before saving, so a form's reader gets
// the service's own confirmation or refusal in place, not a later "not connected" card. `ok: false` is a reported
// failure; `checked: false` means no test exists at all, a different thing that must never render as one.
export const CapabilityProbeSchema = z.object({
    checked: z.boolean().describe("Whether this connection can be tested from here at all. False is not a failure: it is 'no test exists'."),
    ok: z.boolean().describe("Whether the service answered as itself."),
    message: z
        .string()
        .describe("What happened, in the words a person standing in front of the form needs: the service's own answer, or its refusal."),
});
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;
