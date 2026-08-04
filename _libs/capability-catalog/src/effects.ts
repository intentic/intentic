import type { CapabilityContribution, ExtensionManifest } from "@intentic/extension-api";
import type { CapabilityKind } from "@intentic/sandbox-contract";

/* What adding a capability DOES to the sandbox, as data — the structured counterpart of the handlers' side
 * effects (the sandbox's capabilities/handlers/*), rendered by the web as the "This will add to your sandbox"
 * panel before an add and as per-instance effect strips after. Derived, not declared per card: config-dependent
 * effects (a plugin's clone URL, the SQL card's engine-dependent client image) and contribution/extension-declared
 * ones (secret fields, image fragments, processes) are computed from the same contribution data the handlers
 * consume, so there is no per-card effects list to drift. The streamed apply log stays the post-apply record;
 * this is the pre-add disclosure.
 *
 * IN THE CATALOG, not in the wire contract, though it lived there first. Nothing on the wire carries an effect:
 * only the browser computes them, and it computes them from the same per-kind facts the cards next door already
 * declare. Keeping it here means a kind's user-facing story — its card, its fields, and what adding it does — is
 * one package to open, and the contract holds only what actually crosses a socket.
 *
 * A TABLE, not a switch, for the same reason the cards are a list: this is per-kind data. `Record<CapabilityKind,
 * …>` keeps the compiler's demand that every kind answer — the exhaustiveness a switch bought — while making a
 * new kind one entry rather than an arm spliced into a hundred-line function. */

export type CapabilityEffect =
    // Writes .claude/skills/<name>/SKILL.md, auto-loaded by the agent next turn. `name` is the instance id for
    // cli/browser (per-instance skills), the fixed shared skill for ssh/vpn; absent while the instance is unnamed.
    | { readonly kind: "skill"; readonly name?: string | undefined }
    // Stores a credential in the sandbox. "agent-env": injected into the agent's environment each turn, never
    // written to a file (cli). "disk": a 0600 file or a denylisted manifest field (ssh key, vpn conf, git token).
    | { readonly kind: "secret"; readonly exposure: "agent-env" | "disk" }
    // Git-clones a repo into .intentic/plugins|extensions/<id>. `url` absent until the form field is filled.
    | { readonly kind: "clone"; readonly url?: string | undefined }
    // Bakes a Dockerfile fragment into the sandbox image overlay — needs a one-time owner rebuild.
    | { readonly kind: "image" }
    // The baked fragment carries a privileged runtime directive: "net-admin" (vpn NET_ADMIN + tun) or
    // "privileged" (docker — the full --privileged run its dockerd needs).
    | { readonly kind: "runtime"; readonly level: "net-admin" | "privileged" }
    /* The host's GPUs, passed into the sandbox (docker's gpu option). Its own member rather than a third
     * `runtime` level because what it costs is not a privilege inside the container but a resource OUTSIDE it:
     * `--gpus=all` claims every GPU on that machine, and on the shared workstation or homelab box these
     * sandboxes actually run on, that is somebody's inference job. A user reading "requires GPU access" would
     * assume the polite thing was happening; this member exists so the panel can say the impolite one. */
    | { readonly kind: "gpu" }
    /* Settings applied by RESTARTING a long-running process rather than by rebuilding anything (docker's
     * engine options → /etc/docker/daemon.json → dockerd). The good news is the cheap half — no rebuild — and
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
    // Extension code runs inside the app with the owner's session — the owner-only trust decision.
    | { readonly kind: "trusted-code" }
    // Keeps a logged-in Chromium profile under .intentic/browser/<platform> that the agent drives.
    | { readonly kind: "profile"; readonly platform: string }
    // Gives the agent hands on a computer the user OWNS — the most consequential effect in this union, so it
    // spells out the grant rather than naming a mechanism. `grants` is the scopes ticked on the card, in the
    // machine's own words; the machine's agent enforces exactly these and refuses the rest.
    | { readonly kind: "machine"; readonly platform: string; readonly grants: readonly string[] }
    // Sends this sandbox's turns to a model API the user configured. Its own member rather than a variant of an
    // existing one because nothing else in this union describes where a conversation GOES, and that is the whole
    // consequence of adding an endpoint: no file is written, no process runs, no image changes — the prompts,
    // file contents and command output of every turn on it simply leave for that URL. `url` is named because a
    // typo'd host is exactly the mistake this disclosure exists to catch before it is made.
    | { readonly kind: "endpoint"; readonly url: string };

export interface CapabilityEffectInput {
    readonly kind: CapabilityKind;
    // The instance name — the skill name for cli/browser, the repo name for monorepo.
    readonly id?: string | undefined;
    // Live form values, or a CapabilitySummary's secret-stripped config echo (hasToken/hasSecret booleans).
    readonly config: Record<string, string | number | boolean | undefined>;
    // The card's contribution — the source of truth for its secret/fragment declarations (cli/browser/host).
    readonly contribution?: CapabilityContribution | undefined;
    // An installed extension's manifest — resolves its process/image contributions (unknowable before install).
    readonly manifest?: ExtensionManifest | undefined;
}

const filled = (value: string | number | boolean | undefined): boolean => typeof value === "string" && value.length > 0;
// A token either typed into the form (`token`) or echoed as present on an installed instance (`hasToken`).
const hasToken = (config: CapabilityEffectInput["config"]): boolean => filled(config["token"]) || config["hasToken"] === true;
const cloneUrl = (config: CapabilityEffectInput["config"]): string | undefined => (filled(config["url"]) ? String(config["url"]) : undefined);
// The docker config keys that live in daemon.json rather than the image (DockerConfigSchema's engine family) —
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
        // hasSecret — which the web also synthesizes from the card's own secret-marked fields, so the secret row
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
    // The engine is baked into the base image — the "image" effect here is the overlay rebuild that applies the
    // fragment's --privileged directive, not new tooling. The gpu option adds real tooling (the container
    // toolkit) and the claim on the host's GPUs; it is the one part of this card the user chose.
    docker: (input) => [
        { kind: "image" },
        { kind: "runtime", level: "privileged" },
        ...(input.config["gpu"] === "on" || input.config["gpu"] === true ? [{ kind: "gpu" } as const] : []),
        // The engine family (DockerConfigSchema): any of them set means the apply rewrites daemon.json and
        // bounces dockerd. Config-derived like every other conditional effect here — the panel shows it while
        // the user is still typing the value that causes it.
        ...(ENGINE_OPTIONS.some((key) => filled(input.config[key])) ? [{ kind: "restart", process: "dockerd" } as const] : []),
        { kind: "process", names: ["dockerd"] },
    ],
    browser: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }, { kind: "image" }];
        const platform = input.config["platform"];
        if (typeof platform === "string") {
            effects.push({ kind: "profile", platform });
        }
        return effects;
    },
    host: (input) => {
        // Reads are the floor (a machine you cannot read is not connected to anything); the other three are the
        // card's toggles. Unset ⇒ the schema's defaults, which is what the form posts before it is touched.
        const grants = [
            ...(input.config["shell"] === "off" ? [] : ["run commands"]),
            "read files",
            ...(input.config["write"] === "on" ? ["write and trash files"] : []),
            ...(input.config["screen"] === "off" ? [] : ["capture the screen"]),
            ...(input.config["control"] === "on" ? ["use the mouse and keyboard"] : []),
        ];
        return [{ kind: "machine", platform: String(input.config["platform"] ?? ""), grants }, { kind: "skill", name: input.id }, { kind: "mcp" }];
    },
    endpoint: (input) => {
        // The destination is the effect; a key is the ordinary second one. Deliberately no `image` or `process`
        // row: the endpoint rides the translator that is already in the image and already running, so adding one
        // needs no rebuild and starts nothing — which is worth the panel NOT claiming.
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
};

export const capabilityEffects = (input: CapabilityEffectInput): readonly CapabilityEffect[] => KIND_EFFECTS[input.kind](input);
