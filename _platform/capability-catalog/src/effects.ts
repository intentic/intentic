import type { CapabilityContribution, ExtensionManifest } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract";

/* What adding a capability DOES to the sandbox, as data, the structured counterpart of the handlers' side
 * effects (the sandbox's capabilities/handlers/*), rendered by the web as the "This will add to your sandbox"
 * panel before an add and as per-instance effect strips after. Derived, not declared per card: config-dependent
 * effects (a plugin's clone URL, the SQL card's engine-dependent client image) and contribution/extension-declared
 * ones (secret fields, image fragments, processes) are computed from the same contribution data the handlers
 * consume, so there is no per-card effects list to drift. The streamed apply log stays the post-apply record;
 * this is the pre-add disclosure.
 *
 * IN THE CATALOG, not in the wire contract, though it lived there first. Nothing on the wire carries an effect:
 * only the browser computes them, and it computes them from the same per-kind facts the cards next door already
 * declare. Keeping it here means a kind's user-facing story, its card, its fields, and what adding it does, is
 * one package to open, and the contract holds only what actually crosses a socket.
 *
 * A TABLE, not a switch, for the same reason the cards are a list: this is per-kind data. `Record<CapabilityKind,
 * …>` keeps the compiler's demand that every kind answer, the exhaustiveness a switch bought, while making a
 * new kind one entry rather than an arm spliced into a hundred-line function. */

export type CapabilityEffect =
    // Writes .agents/skills/<name>/SKILL.md, auto-loaded by every runtime next turn. `name` is the instance id for
    // cli/browser (per-instance skills), the fixed shared skill for ssh/vpn; absent while the instance is unnamed.
    | { readonly kind: "skill"; readonly name?: string | undefined }
    // Stores a credential in the sandbox. "agent-env": injected into the agent's environment each turn, never
    // written to a file (cli). "disk": a 0600 file, or a field in the off-workspace secret vault the manifest
    // points at with a marker (ssh key, vpn conf, git token).
    | { readonly kind: "secret"; readonly exposure: "agent-env" | "disk" }
    // Git-clones a repo into .intentic/records/plugins|extensions/<id>. `url` absent until the form field is filled.
    | { readonly kind: "clone"; readonly url?: string | undefined }
    // Bakes a Dockerfile fragment into the sandbox image overlay, needs a one-time owner rebuild.
    | { readonly kind: "image" }
    // The baked fragment carries a privileged runtime directive: "net-admin" (vpn NET_ADMIN + tun) or
    // "privileged" (docker, the full --privileged run its dockerd needs).
    | { readonly kind: "runtime"; readonly level: "net-admin" | "privileged" }
    /* The host's GPUs, passed into the sandbox (docker's gpu option). Its own member rather than a third
     * `runtime` level because what it costs is not a privilege inside the container but a resource OUTSIDE it:
     * `--gpus=all` claims every GPU on that machine, and on the shared desktop or homelab box these
     * sandboxes actually run on, that is somebody's inference job. A user reading "requires GPU access" would
     * assume the polite thing was happening; this member exists so the panel can say the impolite one. */
    | { readonly kind: "gpu" }
    /* Settings applied by RESTARTING a long-running process rather than by rebuilding anything (docker's
     * engine options → /etc/docker/daemon.json → dockerd). The good news is the cheap half, no rebuild, and
     * saying only that would be the misleading half: a restart takes every container the agent had running
     * down with it. Named so the panel can put both halves in one line. */
    | { readonly kind: "restart"; readonly process: string }
    // Runs long-lived background processes in the sandbox (an extension's declared processes).
    | { readonly kind: "process"; readonly names: readonly string[] }
    // Registers an mcp__<id>__ server the agent connects to next turn.
    | { readonly kind: "mcp" }
    // Scaffolds workspace repositories. Empty while a name-derived repo is still unnamed.
    | { readonly kind: "scaffold"; readonly repos: readonly string[] }
    // Writes a managed deploy.config.ts entry; `provisions` = also runs the infra apply job now (service).
    | { readonly kind: "deploy"; readonly provisions: boolean }
    // Extension code runs inside the app with the owner's session, the owner-only trust decision.
    | { readonly kind: "trusted-code" }
    // Keeps a logged-in Chromium profile under .intentic/local/browser/<id> that the agent drives, one per connected
    // ACCOUNT, so `platform` here is what the profile is a profile OF, not what it is keyed by.
    | { readonly kind: "profile"; readonly platform: string }
    // Gives the agent hands on a computer the user OWNS, the most consequential effect in this union, so it
    // spells out the grant rather than naming a mechanism. `grants` is the scopes ticked on the card, in the
    // machine's own words; the machine's agent enforces exactly these and refuses the rest.
    | { readonly kind: "machine"; readonly platform: string; readonly grants: readonly string[] }
    // Sends this sandbox's turns to a model API the user configured. Its own member rather than a variant of an
    // existing one because nothing else in this union describes where a conversation GOES, and that is the whole
    // consequence of adding an endpoint: no file is written, no process runs, no image changes, the prompts,
    // file contents and command output of every turn on it simply leave for that URL. `url` is named because a
    // typo'd host is exactly the mistake this disclosure exists to catch before it is made.
    | { readonly kind: "endpoint"; readonly url: string }
    /* Lets the agent spend REAL MONEY, the wallet card, and the only effect in this union whose consequence
     * is measured in dollars. Its own member for the `machine` reason: nothing else here describes value
     * leaving the owner's control, and a user reading "stores a credential" would not learn the thing that
     * actually matters. The two numbers are the ceilings the signer enforces (per payment, per UTC day), and
     * `carded` says whether every payment stops for a click or a band of them settles on the owner's
     * standing delegation, which is the difference between "it asks" and "it asks sometimes", and exactly
     * what a person deciding this needs on the row. */
    | { readonly kind: "spend"; readonly perPaymentUsd: string; readonly dailyUsd: string; readonly carded: boolean };

export interface CapabilityEffectInput {
    readonly kind: CapabilityKind;
    // The instance name, the skill name for cli/browser, the repo name for monorepo.
    readonly id?: string | undefined;
    // Live form values, or a CapabilitySummary's secret-stripped config echo (hasToken/hasSecret booleans).
    readonly config: Record<string, string | number | boolean | undefined>;
    // The card's contribution, the source of truth for its secret/fragment declarations (cli/browser/host).
    readonly contribution?: CapabilityContribution | undefined;
    // An installed extension's manifest, resolves its process/image contributions (unknowable before install).
    readonly manifest?: ExtensionManifest | undefined;
}

const filled = (value: string | number | boolean | undefined): boolean => typeof value === "string" && value.length > 0;
// A token either typed into the form (`token`) or echoed as present on an installed instance (`hasToken`).
const hasToken = (config: CapabilityEffectInput["config"]): boolean => filled(config["token"]) || config["hasToken"] === true;
const cloneUrl = (config: CapabilityEffectInput["config"]): string | undefined => (filled(config["url"]) ? String(config["url"]) : undefined);
// A typed-in address as the site a person would name, undefined until it is a whole http(s) URL, which is most
// of the time while someone is still typing one, so the row this feeds falls back rather than flickering.
const host = (value: string | number | boolean | undefined): string | undefined => {
    if (!filled(value)) {
        return undefined;
    }
    try {
        const parsed = new URL(String(value));
        return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : undefined;
    } catch {
        return undefined;
    }
};
// The docker config keys that live in daemon.json rather than the image (DockerConfigSchema's engine family),
// setting any of them is what makes an apply bounce dockerd.
const ENGINE_OPTIONS = ["registryMirror", "insecureRegistries", "addressPool"] as const;

const KIND_EFFECTS: Record<CapabilityKind, (input: CapabilityEffectInput) => readonly CapabilityEffect[]> = {
    devops: () => [{ kind: "scaffold", repos: ["intent", "desired-state"] }],
    monorepo: (input) => [{ kind: "scaffold", repos: input.id === undefined || input.id.length === 0 ? [] : [input.id] }],
    mcp: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "mcp" }];
        if (hasToken(input.config)) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    service: () => [{ kind: "deploy", provisions: true }],
    integration: () => [{ kind: "deploy", provisions: false }],
    cli: (input) => {
        // Without the contribution (extensions query pending / sandbox unreachable) fall back to the echoed
        // hasSecret, which the web also synthesizes from the card's own secret-marked fields, so the secret row
        // never waits on /extensions. The image row does wait: a connector's fragment (postgres/mysql clients,
        // discord's whisper) is spec data with no static counterpart on the card.
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }];
        const secret =
            input.contribution === undefined ? input.config["hasSecret"] === true : input.contribution.fields.some((field) => field.secret === true);
        if (secret) {
            effects.push({ kind: "secret", exposure: "agent-env" });
        }
        if (input.contribution?.kind === "cli" && input.contribution.fragment !== undefined) {
            effects.push({ kind: "image" });
        }
        return effects;
    },
    plugin: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "clone", url: cloneUrl(input.config) }];
        if (hasToken(input.config)) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    extension: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "trusted-code" }, { kind: "clone", url: cloneUrl(input.config) }];
        if (hasToken(input.config)) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        const contributes = input.manifest?.contributes;
        if (contributes?.environment !== undefined) {
            effects.push({ kind: "image" });
        }
        if (contributes?.processes !== undefined && contributes.processes.length > 0) {
            effects.push({ kind: "process", names: contributes.processes.map((process) => process.name) });
        }
        return effects;
    },
    ssh: () => [
        { kind: "secret", exposure: "disk" },
        { kind: "skill", name: "ssh" },
    ],
    vpn: () => [{ kind: "secret", exposure: "disk" }, { kind: "skill", name: "vpn" }, { kind: "image" }, { kind: "runtime", level: "net-admin" }],
    /* A geo exit, and the row that changes with the PROVIDER rather than being fixed for the kind, which is
     * the honest way to disclose it. A tor exit installs a package and asks for nothing else: no credential
     * (there is no account), and NO container privilege, because tor publishes its own SOCKS port and needs
     * neither a tun device nor NET_ADMIN. Charging every tor user a privilege row they never use would be
     * exactly the quiet over-ask this panel exists to prevent. The tunnel-building providers do need it, and
     * only the paste-your-own arm stores a credential (the .conf files hold private keys). */
    exit: (input) => {
        const provider = input.config["provider"] ?? "tor";
        const effects: CapabilityEffect[] = [{ kind: "skill", name: "geo" }, { kind: "image" }];
        if (provider !== "tor") {
            effects.push({ kind: "runtime", level: "net-admin" });
        }
        if (provider === "wireguard") {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    // The engine is baked into the base image, the "image" effect here is the overlay rebuild that applies the
    // fragment's --privileged directive, not new tooling. The gpu option adds real tooling (the container
    // toolkit) and the claim on the host's GPUs; it is the one part of this card the user chose.
    docker: (input) => [
        { kind: "image" },
        { kind: "runtime", level: "privileged" },
        ...(input.config["gpu"] === "on" || input.config["gpu"] === true ? [{ kind: "gpu" } as const] : []),
        // The engine family (DockerConfigSchema): any of them set means the apply rewrites daemon.json and
        // bounces dockerd. Config-derived like every other conditional effect here, the panel shows it while
        // the user is still typing the value that causes it.
        ...(ENGINE_OPTIONS.some((key) => filled(input.config[key])) ? [{ kind: "restart", process: "dockerd" } as const] : []),
        { kind: "process", names: ["dockerd"] },
    ],
    browser: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }, { kind: "image" }];
        /* WHICH SITE the stored session belongs to. A site card's `platform` slug IS the site (reddit, npmjs), but
         * the generic session's is the card ("website") and would disclose "keeps a logged-in website browser
         * profile", true of nothing in particular, on the row where the user decides whether to store a session
         * and a passkey at all. So the address they typed wins, read down to its host: the row names the site
         * being connected while they are still typing it. */
        const site = host(input.config["homeUrl"]) ?? host(input.config["loginUrl"]) ?? input.config["platform"];
        if (typeof site === "string" && site !== "") {
            effects.push({ kind: "profile", platform: site });
        }
        // The account's stored password, typed into the site by the daemon on the agent's behalf, never shown
        // to the agent. A form value while adding, hasPassword off a stored entry's masked echo.
        if (filled(input.config["password"]) || input.config["hasPassword"] === true) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    identity: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }, { kind: "image" }];
        /* The standing consequence of an identity is its BROWSER, one profile the accounts born from it share,
         * signed into the email's own provider. Named by the address's domain (gmail.com), which is the site the
         * profile actually holds a session for; the email's local part is the user's own name and stays off the
         * disclosure row. */
        const email = filled(input.config["email"]) ? String(input.config["email"]) : "";
        const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : "";
        effects.push({ kind: "profile", platform: domain === "" ? "email" : domain });
        // The identity's stored email password, typed by the daemon on the agent's behalf, never shown to it.
        if (filled(input.config["password"]) || input.config["hasPassword"] === true) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    host: (input) => {
        // Reads are the floor (a machine you cannot read is not connected to anything); the rest are the
        // card's toggles. Unset ⇒ the schema's defaults, which is what the form posts before it is touched.
        const grants = [
            ...(input.config["shell"] === "off" ? [] : ["run commands"]),
            "read files",
            ...(input.config["write"] === "on" ? ["write and trash files"] : []),
            ...(input.config["screen"] === "off" ? [] : ["capture the screen"]),
            ...(input.config["control"] === "on" ? ["use the mouse and keyboard"] : []),
            ...(input.config["sandboxes"] === "on" ? ["start and stop its sandboxes"] : []),
        ];
        return [{ kind: "machine", platform: String(input.config["platform"] ?? ""), grants }, { kind: "skill", name: input.id }, { kind: "mcp" }];
    },
    endpoint: (input) => {
        // The destination is the effect; a key is the ordinary second one. Deliberately no `image` or `process`
        // row: the endpoint rides the translator that is already in the image and already running, so adding one
        // needs no rebuild and starts nothing, which is worth the panel NOT claiming.
        const effects: CapabilityEffect[] = [{ kind: "endpoint", url: filled(input.config["baseUrl"]) ? String(input.config["baseUrl"]) : "" }];
        if (filled(input.config["apiKey"]) || input.config["hasSecret"] === true) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    agent: (input) => {
        // The spawned ACP subprocess is the standing consequence; a pasted env block is a stored credential.
        const effects: CapabilityEffect[] = [{ kind: "process", names: input.id === undefined || input.id.length === 0 ? [] : [input.id] }];
        if (filled(input.config["env"]) || input.config["hasSecret"] === true) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    /* The standing consequence is the server the daemon runs; the multi-gigabyte download is disclosed on the
     * model field itself, where the choice that sizes it is made. No `endpoint` row on purpose: that member
     * exists to say a conversation LEAVES for a URL, and the whole point of this card is that it doesn't. The
     * image + gpu rows appear exactly when the GPU switch is on, the one ask that rebuilds anything on the
     * published image (the docker card's gpu option, one layer shallower). */
    localmodel: (input) => [
        { kind: "process", names: ["llama-server"] },
        ...(input.config["gpu"] === "on" || input.config["gpu"] === true ? [{ kind: "image" } as const, { kind: "gpu" } as const] : []),
    ],
    /* Deliberately NO `secret` row, which is the most informative thing this card's disclosure can say: the
     * signing key is held by the platform's custody provider and never enters the sandbox, so adding a
     * wallet stores no credential here at all. What it does add is the spend itself, with the numbers the
     * user is typing while they read the row. */
    wallet: (input) => [
        {
            kind: "spend",
            perPaymentUsd: filled(input.config["perPaymentMaxUsd"]) ? String(input.config["perPaymentMaxUsd"]) : "1.00",
            dailyUsd: filled(input.config["dailyCapUsd"]) ? String(input.config["dailyCapUsd"]) : "5.00",
            // Every payment stops for a click unless the owner opened an auto-approve band above zero.
            carded: !filled(input.config["autoApproveUnderUsd"]) || Number(input.config["autoApproveUnderUsd"]) === 0,
        },
        { kind: "skill", name: "wallet" },
    ],
};

export const capabilityEffects = (input: CapabilityEffectInput): readonly CapabilityEffect[] => KIND_EFFECTS[input.kind](input);
