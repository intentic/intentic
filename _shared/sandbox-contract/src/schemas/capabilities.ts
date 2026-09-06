// Capabilities: the one `{ id, kind, config }` entry every connection a sandbox holds is written as.
// The config arm per kind, the discriminated union over them, and what the Capabilities page reads:
// each row's live status, the probe behind it, and the connect/rename/sign-in inputs.
import { z } from "zod";
import { ExitConfigSchema } from "./exit.js";
import { entryId } from "./internal.js";
import { ServiceKindSchema } from "./inventory.js";
import { VpnConfigSchema } from "./vpn.js";
// Everything a user adds to a sandbox is a capability with an idempotent apply + a status check. The manifest is
// the source of truth for what's active; `mcp`-kind entries also feed the agent's MCP servers each turn. DevOps
// is the capability that scaffolds the intent/desired-state repos, until it's active the sandbox is empty.

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
// External-app credential injected into DEPLOYED apps (i.have.stripe → STRIPE_API_KEY from env). Agent-facing
// connectors are `cli` capabilities instead (see below), not integrations.
// Closed, unlike a `cli` provider: this becomes an `i.have.<provider>` entry in deploy.config.ts, and the
// desired-state resolver only knows the providers in InventoryProviderSchema. So an integration card is NOT
// extension-contributable, the vocabulary belongs to the deploy engine, not to a manifest.
export const IntegrationConfigSchema = z.object({
    provider: z.literal("stripe").describe("Which outside service's credential to make available to deployed apps."),
});
// A `cli` capability gives the AGENT an authenticated command-line tool (not a deployed-app credential like
// `integration`): the credential + any non-secret URL are stored here and injected into the agent's env each
// turn (see cliEnvOf), and an .agents/skills/<id> cheatsheet teaches the agent to use it via curl. The provider
// data (fields, env, skill, image fragment) is DATA in an installed extension's `contributes.capabilities`, not
// a per-provider schema arm, so the config is `provider` + arbitrary string fields, validated against the
// card's declared fields at add-time (see the sandbox's capabilities/contributions.ts) rather than by this schema.
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
// A Claude Code plugin from a git repo. The daemon only owns the checkout; the Agent SDK's plugin loader reads
// its internals (skills/agents/hooks/commands/.mcp.json). `path` = subdirectory for plugins that live inside a
// marketplace/monorepo checkout. `token` = https auth for private repos (never echoed; becomes hasToken).
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
// An intentic extension from a git repo (an intentic-extension.json checkout. UI bundle + agent contributions
// + processes). Unlike `plugin`, `ref` is a REQUIRED full commit sha: extension code runs trusted in the
// owner's browser, so the owner approves exactly the code that runs, pin by construction, updates are explicit
// re-adds at a new sha. `path`/`token` as in PluginConfigSchema.
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
    /* The registry row's tier, copied onto the install by the browse pre-fill. `premium` is what the daemon's
     * two pool duties key off: installing (or updating) donates the owner's credits to the publisher, the
     * gate the apply passes through, and enabling needs the owner's membership. An absent tier means free,
     * donates nothing, and asks for nothing; NO usage is metered or reported either way. Self-declared rather
     * than verified against the registry (the daemon is the owner's own machine; a stripped marker skips a
     * donation the owner was choosing to make, which cheats the creator once, and is exactly the honesty the
     * open-source posture accepts and the docs state). */
    tier: z
        .enum(["free", "premium"])
        .optional()
        .describe(
            "Whether installing this donates credits to its publisher. Absent means free, which donates nothing and asks for nothing. Taken from the listing rather than checked against it, which is the honesty an open-source posture accepts.",
        ),
    /* The registry this install's row lives in, copied on by the browse pre-fill like `tier`, what the update
     * check compares the pinned sha against and reads advisories from. Absent (a hand-typed git install) falls
     * back to the official registry: if the extension is listed there, its updates and its blocked-markings
     * concern this owner exactly as much as anyone's. */
    registry: z
        .url()
        .optional()
        .describe(
            "Which registry this install came from, which is what update checks and security advisories are read against. Absent falls back to the official one.",
        ),
});
// A remote machine the AGENT can reach over SSH. One capability = one machine; the id is its ssh-config Host
// alias, so the agent runs `ssh <id> "…"`. The handler writes a per-machine config block + a 0600 key/password
// file under ~/.ssh (see the ssh handler), so, unlike `cli`, nothing is injected into the agent's env, and
// several machines never collide. Discriminated by auth so exactly one credential shape is required.
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
/* What is OPTIONAL about the in-sandbox Docker Engine. The engine itself takes no configuring, the capability
 * either runs dockerd or it doesn't, so this holds only what a user chooses, and the bar for landing here is
 * that the sandbox works without it. (`--privileged` therefore is not here and never will be: dockerd does not
 * run without it, so a switch would offer a broken sandbox as a choice.)
 *
 * TWO FAMILIES, and which one an option belongs to is the most consequential thing about it, because it is the
 * difference between a five-second change and a five-minute one:
 *
 *   IMAGE (`gpu`), rides the environment overlay. Changing it recomposes the Dockerfile, so it costs an
 *     owner-approved rebuild and a container recreate. Only `fragment()` may read these.
 *   ENGINE (everything below it): /etc/docker/daemon.json, which dockerd reads at start. Changing one
 *     rewrites the file and restarts dockerd: no rebuild, no new image, but it DOES stop whatever containers
 *     the engine is running, which is why it is disclosed rather than silently applied.
 *
 * Keep the split honest in both directions: an engine option that leaked into the fragment would demand a
 * rebuild for a value dockerd re-reads anyway, and an image option applied by rewriting a file would silently
 * do nothing. The card badges the difference per field (CapabilityField.rebuild).
 *
 * Flat rather than nested, and "on"/"off" rather than booleans, because the capability form carries a flat
 * bag of strings, one spelling of a two-state config across the manifest (the vpn's pfs/aggressive) beats a
 * second one for the same shape. */
export const DockerConfigSchema = z.object({
    gpu: z.enum(["on", "off"]).default("off"),
    /* A pull-through cache or mirror, for a slow, metered or air-gapped link. The nested engine starts with an
     * empty image store, so the first `docker compose up` in a workspace pulls everything from scratch. */
    registryMirror: z.url().optional(),
    // Registries reachable over plain http or with a self-signed certificate, a LAN registry, or the one a
    // homelab runs beside the sandbox. Space- or comma-separated host:port entries.
    insecureRegistries: z.string().optional(),
    /* The subnet the nested engine carves its container networks out of. Docker's default (172.17/16 and the
     * 172.16/12 pools around it) is the single most common collision with a corporate VPN or a homelab LAN,
     * and the failure it produces is unusually cruel: the sandbox keeps working, dockerd keeps working, and
     * exactly the internal hosts the user was reaching for become unreachable, routed into a bridge instead
     * of down the tunnel. One CIDR, and the pool is carved from it. */
    addressPool: z.string().optional(),
});
// A logged-in browser session the AGENT drives via Playwright MCP tools, for social platforms whose APIs can't
// cover "all the actions" (X reads are paywalled; X community-join and YouTube community-posts have no API). The
// session lives in a persisted Chromium profile under .intentic/local/browser/<id>, established through the guided-login
// WebSocket (/system/browser-login) or by the agent signing in itself. Chromium itself rides this kind's
// Dockerfile fragment, applied on an owner rebuild.
//
// ONE CAPABILITY = ONE ACCOUNT, not one platform: several entries may name the same `platform` (reddit-work and
// reddit-personal), and the ID is what the profile, the login, the passkey and the agent's tool prefix are all
// keyed by, so each account signs in separately and is disconnected on its own.
//
// `platform` is an OPEN slug, not an enum, for the reason `cli`'s `provider` is: a platform is a card, a login URL
// and a skill in an installed extension's `contributes.capabilities`, so the set of them is not a fact this
// contract can know. The add route validates it against the contributed entry instead (see contributions.ts).
//
// `username`/`password` are the account's SIGN-IN CREDENTIALS, on every card rather than declared per platform
// (which box a login form wants filled is the same fact everywhere). Both optional: a profile that signed in by
// hand needs neither, and the password is the entry's SECRET, stored so the daemon can type it into the page on
// the agent's behalf (the accounts tools), never so the agent can read it. When the agent signs UP it has the
// daemon generate and store one here, so the credential outlives the profile's cookies.
//
// `catchall`, the `cli` precedent, for the card that carries no site at all: a GENERIC browser session, where the
// page to open and what the account is for are answered on the form instead of pinned in a manifest. A site card
// pins its URLs and declares no fields; the generic one declares fields and pins nothing, one kind, because
// nothing downstream of the URLs differs. Which other keys are legal is the CARD's business, checked against its
// declared fields at add-time (validateContributionConfig), not this schema's.
//
// `identity` names the identity capability this account was born from (or was filed under): the account then
// lives INSIDE that identity's browser, one profile, one set of cookies, which is what makes "Continue with
// Google" one click instead of a second Google login the platform would block. Absent ⇒ the account keeps its
// own private profile, exactly as every hand-connected account always has.
//
// `purpose` and `openedAt` are the ACCOUNT's own history, core for the same reason `identity` is: what this
// account was opened for and when are facts about the sandbox's own past, not about any site, and a site card
// that declared no fields (every one of them, a pinned-URL card declares none) could not carry them otherwise.
// They are what makes the roster answerable months later, when "do we already have an account here" is asked by
// a session that was not the one that signed up. Both optional: an account the owner connected by hand has no
// signup story to tell, and an empty purpose is better than a fabricated one.
export const BrowserConfigSchema = z
    .object({
        platform: z.string().min(1),
        username: z.string().optional(),
        password: z.string().optional(),
        identity: z.string().optional(),
        purpose: z.string().optional(),
        // ISO-8601 date, stamped when the agent opens the account, absent for one connected by hand.
        openedAt: z.string().optional(),
        /* WHERE THIS ACCOUNT BROWSES FROM: the id of an `exit` capability. Set it and every page this profile
         * opens comes out of that country, with the browser's clock, locale and languages set to match.
         *
         * Only meaningful on an account that owns its OWN profile. An account born from an identity shares
         * that identity's browser, cookies, passkeys and all, so it shares its exit too and this field is
         * ignored for it (see the daemon's browser/browser-exit.ts). That is not a limitation, it is the
         * point: one Google session appearing from Berlin in one tab and Osaka in another is a far louder
         * signal than any address, so the exit belongs to whatever owns the profile. */
        exit: z.string().optional(),
    })
    .catchall(z.string());
/* ONE EMAIL IDENTITY THE SANDBOX ACTS AS ONLINE, the container platform accounts are born from, and the answer
 * to "who is this sandbox on the internet" being twelve separate logins today.
 *
 * WHAT IT OWNS IS A BROWSER. An identity is one persisted Chromium profile the way a person's own browser is
 * one: Google signed in once (by the OWNER's hand, in the guided window, automated Google logins are exactly
 * what Google blocks), and every account born from it sharing those cookies, so a platform's "Continue with
 * Google" is a click rather than an email round-trip. Browser accounts join it by naming it in their `identity`
 * field; accounts that name no identity keep their own private profile, which is how work and personal stay two
 * containers, two identities, not one profile with a flag.
 *
 * WHY A CAPABILITY AND NOT A PERSONA: this card holds SECRETS (an email password the daemon types but never
 * shows) and a live profile's identity, and the personas file is committed to git precisely because it holds
 * neither (personas-store.ts). A persona is how a session BEHAVES; an identity is who the browser IS SIGNED IN
 * as. A persona may point at accounts that live inside an identity, and neither card needs to know the other
 * exists.
 *
 * `email` is the identity itself, what signup forms get typed into their username box, and how the guided
 * login knows where to start (gmail.com ⇒ accounts.google.com; `loginUrl` overrides for any other provider).
 * `password` is the entry's SECRET, the browser-config precedent: typed by the daemon, never readable.
 * `mailbox` names a connected mail capability (imap, google) the narrow code tool reads, the agent asks for
 * "the latest code from this site" and gets six digits, not an inbox.
 * `openAccounts` is THE consent switch, off by default and a select rather than a boolean (the host-scope
 * precedent, form values arrive as strings): automated signup is against most platforms' terms, so minting
 * accounts unattended is an explicit, per-identity, informed choice, never a silent global default. */
export const IdentityConfigSchema = z.object({
    email: z.string().min(3),
    password: z.string().optional(),
    mailbox: z.string().optional(),
    loginUrl: z.url().optional(),
    openAccounts: z.enum(["on", "off"]).default("off"),
    /* WHERE THIS IDENTITY LIVES, the id of an `exit` capability. An identity OWNS a browser profile, and every
     * account born from it shares that profile, so setting it here sets it for all of them at once, which is
     * the only coherent place to set it: the shared thing is one browser, and one browser is in one place. */
    exit: z.string().optional(),
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;
/* A connected DEVICE of the user's own, the inverse of `ssh`, which reaches a server the sandbox can dial.
 * A machine behind NAT can't be dialled, so it dials US: the @intentic/machine agent (installed by a one-liner,
 * enrolled with a single-use pairing token) holds one outbound WebSocket to this daemon and serves an MCP tool
 * surface, shell, files, screenshots, from the far end. The daemon tunnels the agent's JSON-RPC over it and
 * never implements a tool itself, so the machine's capabilities evolve with ITS binary, not with a daemon release.
 *
 * One capability = one machine. The id is the machine's name and namespaces its tools (mcp__laptop__run_command),
 * so several connected machines never collide, the `ssh` precedent. `platform` splits the SKILL pack: a Windows
 * machine is taught PowerShell and a Linux one systemd/D-Bus, and neither carries the other's noise.
 *
 * SCOPES ARE THE GRANT, and they are enforced ON THE MACHINE, never here: the daemon pushes them down on every
 * connect, and the agent refuses out-of-scope calls itself. So a sandbox that is compromised, or an agent talked
 * into it by something it read on the internet, still cannot exceed what the owner ticked. `roots` bounds file
 * reads AND writes to a set of directories (empty ⇒ the user's home).
 *
 * Like a browser `platform`, this is an OPEN slug: an OS is a card plus a skill pack in an installed extension's
 * `contributes.capabilities`, and teaching the agent a new one should not need a daemon release. */
// on/off rather than a boolean: capability configs arrive from the add form as strings (the vpn autoConnect
// precedent), and a select is what the form renders for an enum.
const hostScope = z.enum(["on", "off"]);
export const HostScopesSchema = z.object({
    // Run commands in a real shell (PowerShell on Windows, the login shell on Linux). Off ⇒ files/screen only.
    shell: hostScope.default("on"),
    // Create, modify and trash files under `roots`. Reads are always allowed within them; this is the write half.
    write: hostScope.default("off"),
    // Capture the screen. Off ⇒ screenshot refuses, and the agent is told so rather than getting a black frame.
    screen: hostScope.default("on"),
    /* Move the pointer, click, type and scroll. GUI work, for the things with no command-line way in. Its own
     * switch rather than part of `screen` because looking and touching are not the same permission: a screenshot
     * is bounded by what is on the display, while one click can confirm a dialog nobody read. Default off, like
     * `write`, and for the same reason, a user who has not thought about it should not discover the agent has
     * been driving their desktop. */
    control: hostScope.default("off"),
    /* Start, stop and restart the Intentic sandboxes running on this machine, the grant that makes one sandbox
     * the machine's supervisor. Its own switch rather than a use of `shell` because it is NARROWER: a user can
     * hand an agent the sandbox fleet without handing it a shell, and the fleet operations are named rather than
     * whatever a model improvises with docker. Default off, like every switch that changes the machine. */
    sandboxes: hostScope.default("off"),
    /* Remove a sandbox from this machine, its container, its network, and the named volumes holding its /work
     * and /history. Its own switch rather than part of `sandboxes` because the two differ in the only way that
     * matters here: everything `sandboxes` grants is undone by doing it again, and this is undone by nothing.
     * A user who delegated "restart my sandboxes when they wedge" did not thereby agree to lose one. */
    sandboxRemove: hostScope.default("off"),
    /* Run a command this machine's agent classifies as destructive: a recursive delete, a formatted disk, a
     * removed Docker volume (command-classes.ts, the same classifier the sandbox's own gate reads).
     *
     * ITS OWN SWITCH UNDER `shell`, and the reason is the asymmetry this whole feature turns on. Inside the
     * sandbox a bad `rm -rf` costs a container that exists to be thrown away, so the gate there can afford to
     * hold only the handful of commands nothing undoes and wave the rest through. This is somebody's laptop.
     * There is no image to recreate it from, no checkpoint, no worktree: `rm -rf ~/projects` is the afternoon
     * everybody remembers. And there is no card to raise either, the machine answers a tool call with a value
     * and cannot park it while somebody thinks, so the honest form of "ask me" here is "refuse until they
     * ticked it", which is exactly what a scope is.
     *
     * Default off, with `shell` default ON, which is the pairing to read carefully: a connected device runs
     * commands out of the box, because that is what people connect one for, and the ones that delete are the
     * ones they have to say yes to. */
    destructive: hostScope.default("off"),
    // One directory per line. Empty ⇒ the machine's home directory, which is what the agent reports at connect.
    roots: z.string().optional(),
});
export type HostScopes = z.infer<typeof HostScopesSchema>;
export const HostConfigSchema = HostScopesSchema.extend({ platform: z.string().min(1) });
/* THE USER'S OWN BROWSER, reached through the extension they installed in it: the `webext` capability's config.
 *
 * The sibling of `host` and deliberately not an arm of it. A connected device runs commands; a connected
 * browser has one power a sandbox's own Chromium can never have, and it is the whole reason this kind exists:
 * it is ALREADY SIGNED IN, as the person, with their passkeys, their hardware second factor, their corporate
 * SSO and their genuine fingerprint. That is the set of sites the sandbox's browser cannot reach at all, and
 * copying a session out of one to fake it is what gets an account locked.
 *
 * WHICH SITES the agent may touch is NOT in here, and that omission is the security design rather than a gap.
 * Origins are Chrome's own optional host permissions, asked for by the extension with the person's hands on
 * the keyboard and revocable in the browser's own UI, so the boundary that matters is enforced by the browser
 * against the extension, one layer below anything a sandbox could reach. What the card carries is the coarser
 * question the sandbox's owner answers once: what KIND of thing may happen on a site they have already allowed.
 *
 * Every switch is enforced IN THE EXTENSION (as every host scope is enforced on the machine): the daemon
 * pushes them on connect and on every edit, and nothing on this side checks one. */
const webextScope = z.enum(["on", "off"]);
export const WebExtScopesSchema = z.object({
    // Read a granted page: its elements, its text, its tabs. The floor of usefulness, so it defaults on; with
    // it off the connection is inert and the card says so rather than pretending.
    read: webextScope.default("on"),
    /* Click, type, press keys, navigate. ON by default, unlike a device's `control`, and the difference is
     * what the two things ARE: driving a desktop is the last resort after every command-line route failed,
     * while driving the page IS this connector — a browser connection that may only look is a worse version
     * of fetching the URL. The grant that actually bounds it is per-site and lives in the browser. */
    act: webextScope.default("on"),
    /* Capture the visible tab as an image. Off by default because it is the one read whose contents nothing
     * here bounds: the page serialization above is a list this extension built and can keep to granted frames,
     * while a screenshot is whatever pixels that window happens to be showing. Worth turning on for canvas
     * apps and PDF viewers, which is exactly when the DOM says nothing. */
    screenshot: webextScope.default("off"),
    /* Hand a site's logged-in session to the sandbox's own browser ("Connect this site"), so a job can carry
     * on overnight with the laptop shut. Off by default and deliberately hard to turn on by accident: it is
     * the only switch here that COPIES a credential rather than borrowing the browser holding it, and some
     * sites answer a session arriving from a new fingerprint by invalidating it. */
    cookies: webextScope.default("off"),
    /* When the person is asked, in the browser, before an action goes through. "sensitive" is the default and
     * the interesting one: a submit on a page that carries a password field, a payment form or a delete
     * confirmation waits for a human click; ordinary navigation and typing do not. "always" makes every action
     * a prompt (correct for a first week, exhausting after it); "never" is the owner saying they will watch
     * instead, which they genuinely can, because they are looking at the tab. */
    confirm: z.enum(["sensitive", "always", "never"]).default("sensitive"),
});
export type WebExtScopes = z.infer<typeof WebExtScopesSchema>;
// Like a host's, `platform` is an OPEN slug naming the card (chrome, firefox): the browser family decides the
// skill pack's wording and the install link, and teaching the agent a new one should not need a daemon release.
export const WebExtConfigSchema = WebExtScopesSchema.extend({ platform: z.string().min(1) });
export type WebExtConfig = z.infer<typeof WebExtConfigSchema>;
// An ACP (Agent Client Protocol) agent served as a chat provider: the daemon spawns `command` as a long-lived
// subprocess speaking JSON-RPC over stdio, and the capability id becomes the provider id in the chat picker
// (see AgentProviderSchema). `command` is split on whitespace, no shell quoting. `env` is a pasted KEY=VALUE
// block (one per line); credentials ride here, so the whole block is the secret field (echoed as hasSecret),
// the vpn-conf precedent. `loginCommand` is an interactive login the user completes in a visible terminal
// (device-code flows); the agent persists credentials in its own store inside the container. `name` is the
// picker's display label; absent = the id.
export const AcpAgentConfigSchema = z.object({
    command: z.string().min(1),
    name: z.string().min(1).optional(),
    env: z.string().optional(),
    loginCommand: z.string().min(1).optional(),
});
/* A MODEL API THE USER POINTED US AT, one shape for every server that serves models over HTTP, whether it runs
 * beside this container or in another datacentre. There is deliberately NO local/remote axis: an Ollama on the
 * docker host, a vLLM on the GPU box down the hall, a LiteLLM gateway and OpenRouter differ only in the URL, and
 * inventing a distinction would mean two code paths, two cards and two sets of bugs for one concept.
 *
 * `protocol` is the only real fork, and it is about the WIRE, not about where the server lives:
 *   openai   , the endpoint speaks OpenAI /v1/chat/completions (Ollama, vLLM, llama.cpp, LM Studio, TGI,
 *               OpenRouter, most gateways). The Claude Code harness speaks only the Anthropic Messages API, so
 *               these are re-served through the bundled translator, which is already in the image for exactly
 *               this job (agent/translator.ts). The user's key stays in the translator's config on /history and
 *               never reaches the harness, it gets the loopback bearer instead.
 *   anthropic, the endpoint already speaks the Anthropic Messages API (LiteLLM's /v1/messages, a Bedrock or
 *               Vertex router, a corporate Anthropic gateway). Nothing to translate: the harness is pointed
 *               straight at it with the user's own key.
 *
 * `headers` is a pasted `Name: value` block, one per line, the extra headers gateways ask for (a tenant id, a
 * routing hint). The key is the secret field; the header block is not, because it is where non-credential
 * routing metadata lives and hiding it would make a misrouted endpoint undiagnosable. */
export const EndpointProtocolSchema = z.enum(["openai", "anthropic"]);
export type EndpointProtocol = z.infer<typeof EndpointProtocolSchema>;
export const EndpointConfigSchema = z.object({
    // The API root, INCLUDING the version segment the server publishes (…:11434/v1). Taken verbatim rather than
    // normalised: "which suffix does this server want" is the one thing that actually varies between them, and
    // guessing it is how a working URL becomes an unexplainable 404.
    baseUrl: z.url(),
    protocol: EndpointProtocolSchema.default("openai"),
    apiKey: z.string().optional(),
    headers: z.string().optional(),
});
/* A MODEL THE SANDBOX RUNS ITSELF, the managed counterpart of `endpoint`. An endpoint points at a server the
 * USER operates; this one names weights, and the daemon does the operating: it downloads the file into the
 * workspace cache, serves it with the image's bundled llama-server on a loopback port it owns, and registers
 * the result exactly as if the user had added an endpoint at that port. Everything downstream (the picker, the
 * translator, quick-model pinning) sees an `endpoint/<id>` provider and never learns the difference, which is
 * why there is no baseUrl here: the URL is derived from the entry's id (the daemon's endpoints/local-model.ts),
 * not a fact anyone typed.
 *
 * `model` is WHICH WEIGHTS, as a Hugging Face path (`owner/repo/file.gguf`, resolved to the repo's own
 * download), so shipping a new recommended model is a catalog-card edit, not a daemon release. The reserved
 * value "custom" defers to `url`, a direct GGUF link for people who know exactly what they want.
 *
 * `gpu` mirrors the docker card's option and rides the same allowlisted `--gpus=all` directive: the ASK lives
 * here, what became of it is SANDBOX_GPU, stamped by the runner (see the docker handler's gpuState). "on"/"off"
 * rather than a boolean for the manifest-wide reason DockerConfigSchema gives.
 *
 * `context`/`contextTokens` are HOW MUCH CONVERSATION the server holds, the `model`/`url` pair's shape for the
 * same reason: a short list of rungs anyone can choose between, and one escape hatch for a person who knows the
 * exact number they want. Resolved to a single token count in exactly one place (the daemon's
 * endpoints/local-model.ts localModelWindow), because the flag llama-server is started with and the number the
 * card promises must never be two opinions. */
export const LOCAL_MODEL_WINDOWS = ["16384", "32768", "65536", "131072"] as const;
export type LocalModelWindow = (typeof LOCAL_MODEL_WINDOWS)[number];
/* THE RUNG A CARD WITH NO OPINION LANDS ON, and the one number in this block that is a product decision rather
 * than an arithmetic one.
 *
 * It is 65,536 because this sandbox runs a TOOL-CALLING AGENT LOOP, and that loop's own fixed cost, its
 * instructions plus one JSON schema per tool it can call, times every capability the owner has connected, is
 * tens of thousands of tokens before the user has typed anything (agent/context-budget.ts holds the measurement
 * and the refusal built on it). A window that cannot hold that cost is not a smaller version of the product; it
 * is a model whose every real turn is refused, which is what the previous flat 32,768 shipped: a 27B model,
 * seventeen gigabytes downloaded, and a first message that died on `36216 tokens exceeds 32768`.
 *
 * So the default is the smallest rung a full turn fits in, and the smaller rungs stay on the list because they
 * are honestly useful: pinned as the quick model (titles, commit messages) a window this size is waste, and the
 * gigabyte it gives back is the difference between running one of these models on an eight-gigabyte laptop and
 * not. What each rung costs in memory is the card's job to say (capability-catalog): roughly 2 GB of quantized
 * cache per 32k of window, on top of the weights. */
export const LOCAL_MODEL_WINDOW_DEFAULT: LocalModelWindow = "65536";
/* THE BOUNDS ON THE TYPED NUMBER, and they are bounds against a TYPO rather than against a preference. Below
 * the floor there is no conversation left to have once the loop's own instructions land; above the ceiling is a
 * number no GGUF on offer was trained for, and llama-server would spend minutes reserving a cache for it before
 * failing. Everything between is the owner's call: their machine, their memory. */
export const LOCAL_MODEL_WINDOW_MIN = 2048;
export const LOCAL_MODEL_WINDOW_MAX = 1_048_576;
export const LocalModelConfigSchema = z.object({
    model: z.string().min(1),
    gpu: z.enum(["on", "off"]).default("off"),
    url: z.url().optional(),
    context: z.union([z.enum(LOCAL_MODEL_WINDOWS), z.literal("custom")]).default(LOCAL_MODEL_WINDOW_DEFAULT),
    // Coerced because it arrives from a text field as a string, the ssh card's `port` precedent, and only read
    // when `context` is "custom" (the `url`/`model` relationship exactly).
    contextTokens: z.coerce.number().int().min(LOCAL_MODEL_WINDOW_MIN).max(LOCAL_MODEL_WINDOW_MAX).optional(),
});
export type LocalModelConfig = z.infer<typeof LocalModelConfigSchema>;
/* THE SANDBOX WALLET, a USDC balance the agent can spend on x402-payable endpoints, under owner policy.
 *
 * WHAT IS DELIBERATELY NOT HERE IS A KEY. The signing key lives with the PLATFORM (one wallet per owner,
 * reached with the connect token the agent's grant never covers), the container filesystem is explicitly not
 * a boundary in this codebase's threat model (see the daemon's secret-vault.ts header), so the key does not
 * enter the container at all. `address` is the wallet's PUBLIC address, written back by the handler's apply
 * from the platform's answer, never typed by anyone: it is where the owner sends USDC, and everything the
 * agent may know.
 *
 * POLICY IS THE OWNER'S DELEGATION, and its defaults are the conservative ones: every payment raises an
 * approval card (`autoApproveUnderUsd: "0"`), bounded per payment and per UTC day. The daemon enforces it at
 * the route AND the platform re-validates at the signer, the daemon's check is UX, the signer's is the
 * guarantee, so a compromised container can at worst request what the owner already permitted. Amounts are
 * DECIMAL STRINGS, never floats: the daemon does its arithmetic in the token's atomic units (USDC has six
 * decimals), and a float here would be a rounding bug wearing a type.
 *
 * `allow`/`deny` are hostname lists (comma- or newline-separated). Empty allow = any host, each behind its
 * card; deny wins over allow. One capability per sandbox (singleton card): a second balance would just be a
 * second opinion about the same owner's wallet. */
const usdAmount = z.string().regex(/^\d+(\.\d{1,6})?$/, "a USD amount like 0.50 (up to six decimals: USDC's own precision)");
export const WalletNetworkSchema = z.enum(["eip155:8453", "eip155:84532"]);
export type WalletNetwork = z.infer<typeof WalletNetworkSchema>;
export const WalletConfigSchema = z.object({
    // The chain payments settle on, CAIP-2. Base mainnet, or Base Sepolia for test mode (faucet USDC, the
    // whole flow, cards, ledger, receipts, with zero real money).
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
    // A pnpm+turbo monorepo the user scaffolds as its own repo; the `id` is the repo name. No config, apps are
    // added into it afterwards from its operator panel.
    z.object({ id: entryId, kind: z.literal("monorepo"), config: z.object({}) }),
    z.object({ id: entryId, kind: z.literal("mcp"), config: McpConfigSchema }),
    z.object({ id: entryId, kind: z.literal("service"), config: ServiceConfigSchema }),
    z.object({ id: entryId, kind: z.literal("integration"), config: IntegrationConfigSchema }),
    z.object({ id: entryId, kind: z.literal("cli"), config: CliConfigSchema }),
    z.object({ id: entryId, kind: z.literal("plugin"), config: PluginConfigSchema }),
    z.object({ id: entryId, kind: z.literal("extension"), config: ExtensionConfigSchema }),
    z.object({ id: entryId, kind: z.literal("ssh"), config: SshConfigSchema }),
    // No IFNAMSIZ cap on the id: the tunnel's interface name is DERIVED (see the daemon's vpn/vpn-paths.ts
    // interfaceName) rather than being the id itself, so a descriptive name is free.
    z.object({ id: entryId, kind: z.literal("vpn"), config: VpnConfigSchema }),
    // A geo exit (ExitConfigSchema). Same interface-name derivation as vpn, and deliberately NOT a vpn arm:
    // it routes nothing into the main table, so the full-tunnel warning the vpn kind carries stays true.
    z.object({ id: entryId, kind: z.literal("exit"), config: ExitConfigSchema }),
    // The in-sandbox Docker Engine (baked into the base image, dormant by default). Its `--privileged` runtime
    // directive is not in the config and never will be: dockerd does not work without it (see the handler's
    // isPrivileged), so a switch there would offer a broken sandbox as a choice. What IS optional lives in
    // DockerConfigSchema. No remove, the engine's state (/var/lib/docker) and whatever runs on it make a
    // silent de-privilege more destructive than useful.
    z.object({ id: entryId, kind: z.literal("docker"), config: DockerConfigSchema }),
    z.object({ id: entryId, kind: z.literal("browser"), config: BrowserConfigSchema }),
    // One email identity the sandbox acts as online, the browser-owning container accounts are born from
    // (IdentityConfigSchema). Browser entries join it via their `identity` field.
    z.object({ id: entryId, kind: z.literal("identity"), config: IdentityConfigSchema }),
    z.object({ id: entryId, kind: z.literal("host"), config: HostConfigSchema }),
    // The user's own BROWSER, through the extension installed in it (WebExtConfigSchema). The `host` kind's
    // sibling: one capability per browser, the id namespacing its tools, the switches enforced at the far end.
    // Distinct from `browser`, which is the sandbox's OWN Chromium and a profile this container owns — this
    // one is the person's, already signed into everything, and the sandbox only ever borrows it.
    z.object({ id: entryId, kind: z.literal("webext"), config: WebExtConfigSchema }),
    z.object({ id: entryId, kind: z.literal("agent"), config: AcpAgentConfigSchema }),
    // A model API (EndpointConfigSchema). The id becomes `endpoint/<id>` in the chat picker, the `agent` kind's
    // precedent, with the prefix because these two are the only capability kinds that mint providers and they
    // want opposite ability records (an ACP agent owns its own loop; an endpoint runs the full Claude Code one).
    z.object({ id: entryId, kind: z.literal("endpoint"), config: EndpointConfigSchema }),
    // A model the sandbox downloads and serves itself (LocalModelConfigSchema). Deliberately minting the SAME
    // `endpoint/<id>` provider ids as the endpoint kind: to every consumer it IS an endpoint, one the daemon
    // happens to operate, so a second provider namespace would be a second code path for the same turns.
    z.object({ id: entryId, kind: z.literal("localmodel"), config: LocalModelConfigSchema }),
    // The sandbox's USDC wallet (WalletConfigSchema), one per sandbox; the key never enters the container.
    z.object({ id: entryId, kind: z.literal("wallet"), config: WalletConfigSchema }),
]);
export type Capability = z.infer<typeof CapabilitySchema>;
/* `code` is a credential the owner has to TYPE SOMEWHERE ELSE to finish this connection. WhatsApp's
 * link-a-device code, typed into the phone. It is not part of `detail` because the card does not merely print
 * it: it sets it in a size you can read across a desk, next to a copy button, and replaces it in place when the
 * provider mints a new one. A sentence with a code buried in it cannot be any of those things. */
export const CapabilityStatusSchema = z.object({
    state: CapabilityStateSchema.describe("Whether it is live, still coming up, broken, or switched off."),
    detail: z.string().optional().describe("What is wrong, in words a person can act on."),
    code: z.string().optional().describe("A short marker for that reason, for anything deciding what to do about it."),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
/* The list row: manifest entry + live status. Secrets are never returned (an mcp token becomes hasToken).
 *
 * `secrets` NAMES them without carrying them, the config keys this connection is actually holding a credential
 * under. It is what makes an edit form possible at all: `config` is everything the browser may see, so a form
 * seeded from it alone cannot tell "this tunnel has a pre-shared key I'm not allowed to show you" from "this
 * tunnel has no pre-shared key", and both render as an empty required box. Saving one then wipes the
 * credential, which is why changing a routed network used to mean re-typing a key.
 *
 * Keys, never values, and never a boolean per known field: the set is derived from what the entry stores, so a
 * field the user left blank is absent and a card that gained a credential since is present. The form reads it as
 * "show dots, and let blank mean keep" (VAULTED, capability-secrets.ts). */
export const CapabilitySummarySchema = z.object({
    id: z.string().describe("The connection's id."),
    kind: CapabilityKindSchema.describe("What sort of thing it is."),
    status: CapabilityStatusSchema.describe("Whether it is working."),
    config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).describe("Its settings, minus anything secret."),
    // Defaulted for the daemon-older-than-browser seam, like `recommendations` below: a required field would
    // fail the whole list parse against a sandbox predating this, taking the page down to hide some dots.
    secrets: z
        .array(z.string())
        .default([])
        .describe("Which credentials it holds, by name. The values are on one route only, and it is not this one."),
});
/* A capability the WORKSPACE asks for but the manifest doesn't carry, derived from what is checked out under
 * /work, not from anything the user configured. It exists because the failures it prevents are illegible: a
 * compose-backed dev database (`pnpm db:up`) dies on a missing /var/run/docker.sock, and nothing on that error
 * points at the one-time privileged rebuild that fixes it; a workspace full of GitHub repos gets an agent that
 * cannot read one issue until somebody thinks to go looking for the card.
 *
 * KEYED BY CATALOG CARD, NOT BY KIND, because github, gitlab, komodo and every other connector share the single
 * `cli` kind, a kind cannot say which card to open, and matching on one badged all of them at once.
 *
 * WHAT IS STORED IS WHAT WAS SEEN. `evidence` is the artifact itself, a workspace-relative path, a git remote,
 * rendered verbatim so the claim is checkable rather than believed, and `reason` is the same claim in the user's
 * words with the evidence NOT repeated into it. A recommendation is re-derived on every read rather than
 * remembered, so one whose evidence has since moved simply stops being made.
 *
 * `prefill` is the non-secret config the scan could read (a self-hosted instance url, a Komodo core), it fills
 * the card's form so the user supplies only the credential. Secrets are NEVER in here, even when one is sitting
 * in a checked-in file: the flow points at such a file as evidence, it does not absorb what is in it. */
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
    // Defaulted for the daemon-older-than-browser seam: the platform's web app talks to whichever sandbox
    // version the user has, and a required field here would fail the parse, taking the whole Capabilities page
    // down on every sandbox predating this route, to hide a badge.
    recommendations: z
        .array(CapabilityRecommendationSchema)
        .default([])
        .describe(
            "Things worth connecting, worked out from what is actually in the workspace rather than from anything you configured. Re-derived on every read, so one whose evidence has moved simply stops being suggested.",
        ),
});
export const CapabilityIdParamSchema = z.object({ id: z.string().describe("Which connection.") });
/* One capability's config VERBATIM, secrets included, for the connection route (capabilities.connection).
 * The one read on this surface that does not echo secrets as hasToken booleans, which is exactly why it is
 * never served to a browser: its handler refuses any caller with a member identity, leaving only the daemon's
 * header grants (an extension backend's minted token, which must declare the route in permissions.daemon).
 * The values are the strings the capability stored; the caller knows its own kind's field names. */
export const CapabilityConnectionSchema = z.object({
    id: z.string().describe("The connection's id."),
    kind: z.string().describe("What sort of thing it is."),
    config: z
        .record(z.string(), z.string())
        .describe("Its settings exactly as stored, credentials included. The field names are its own kind's, which the caller already knows."),
});
export type CapabilityConnection = z.infer<typeof CapabilityConnectionSchema>;
// DELETE /capabilities/recommendations/{card}: the user said this one is not wanted. The EVIDENCE it was
// declined against is recorded daemon-side rather than sent, so the client cannot dismiss a claim other than the
// one it was shown, and so the recommendation comes back by itself when the workspace changes under it.
export const CapabilityCardParamSchema = z.object({ card: z.string().describe("Which suggestion to stop making.") });
// POST /capabilities/{id}/secret body: replace just the capability's secret field (its key is per-kind, see the
// sandbox's secretField) and re-run its idempotent apply, the /secrets page's edit path.
export const CapabilitySecretInputSchema = z.object({
    id: z.string().describe("Which connection."),
    value: z.string().min(1).describe("The new credential. Its other settings are left alone."),
});
/* POST /capabilities/{id}/rename body: the name this connection should answer to from now on.
 *
 * A capability's id IS the agent's handle for it, its skill file, its tool prefix, its env suffix, the alias
 * `ssh <name>` resolves, so renaming one is a migration and not a label edit. The shape of a name is therefore
 * the same rule the add form enforces, spelled here because the daemon is the gate: letters and digits to start,
 * then hyphens and underscores. Which KINDS may be renamed at all is the handler's own answer (capability.ts
 * `rename`), not something a schema can say. */
export const CapabilityRenameSchema = z.object({
    id: z.string(),
    to: z
        .string()
        .min(1)
        .max(60)
        .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
});
// POST /capabilities/{id}/login response: the interactive tmux session running the agent's loginCommand,
// which the web surfaces in the terminal panel for the user to complete the sign-in.
export const CapabilityLoginSchema = z.object({ session: z.string().describe("The terminal the sign-in is happening in. Attach to it to type.") });
// GET /capabilities/{id}/otp response: one freshly minted TOTP code off the capability's stored seed, what the
// in-sandbox `otp` command prints. The seed itself never crosses; secondsRemaining is the caller's cue to
// re-mint rather than submit a code about to die.
export const CapabilityOtpSchema = z.object({
    code: z.string().describe("The code."),
    secondsRemaining: z
        .number()
        .describe("How long it lasts. Its expiring is what makes handing one to an agent safe, since the seed behind it is never revealed."),
});
/* POST /capabilities/probe response: did these settings actually reach the thing, asked BEFORE they are saved.
 *
 * The answer is a sentence rather than a status code because the reader is standing in front of a form: what
 * they need is either the service's own confirmation ("Reached GitHub, authenticated as ada") or the exact
 * refusal ("GitHub answered 401: the token is not valid"), in the place where the box they would fix still is.
 * That is also the whole point of doing it here: every one of these failures is otherwise discovered after the
 * add, on a card that says "not connected" with nothing about which of six answers was wrong.
 *
 * `ok: false` is a REPORTED failure, not a transport error: the probe ran and the service said no. A card whose
 * settings cannot be checked from here at all answers `checked: false`, which is a different thing from a
 * failure and must never be drawn as one. */
export const CapabilityProbeSchema = z.object({
    checked: z.boolean().describe("Whether this connection can be tested from here at all. False is not a failure: it is 'no test exists'."),
    ok: z.boolean().describe("Whether the service answered as itself."),
    message: z
        .string()
        .describe("What happened, in the words a person standing in front of the form needs: the service's own answer, or its refusal."),
});
export type CapabilityProbe = z.infer<typeof CapabilityProbeSchema>;
