import type { CapabilityContribution, ExtensionManifest } from "@intentic/extension-manifest";
import type { CapabilityKind } from "@intentic/sandbox-contract";

// Structured, computed side effects of adding a capability: pre-add disclosure and post-add strips, derived from the
// same contribution data the handlers consume, so no per-card list can drift. Lives in the catalog, not the wire
// contract; only the browser computes effects. A table, not a switch: a new kind is one entry, not a function arm.

export type CapabilityEffect =
    // Writes .agents/skills/<name>/SKILL.md; `name` is the instance id, or a fixed shared name for ssh/vpn.
    | { readonly kind: "skill"; readonly name?: string | undefined }
    // "agent-env": injected into the agent's environment each turn, never written to a file.
    // "disk": a 0600 file, or a vault field the manifest points at with a marker.
    | { readonly kind: "secret"; readonly exposure: "agent-env" | "disk" }
    // Git-clones into .intentic/records/plugins|extensions/<id>; `url` absent until the form field is filled.
    | { readonly kind: "clone"; readonly url?: string | undefined }
    // Bakes a Dockerfile fragment into the sandbox image overlay, needs a one-time owner rebuild.
    | { readonly kind: "image" }
    // Privileged runtime directive baked into the fragment: "net-admin" (vpn) or "privileged" (docker's dockerd).
    | { readonly kind: "runtime"; readonly level: "net-admin" | "privileged" }
    // Host GPUs passed into the sandbox (docker's gpu option); its own member, not a third `runtime` level, since
    // `--gpus=all` claims every GPU on a possibly shared machine, not just a container privilege.
    | { readonly kind: "gpu" }
    // Applied by restarting a process (docker's daemon.json), not rebuilding; cheap, but a restart takes every running
    // container down with it.
    | { readonly kind: "restart"; readonly process: string }
    // Runs an extension's declared long-lived background processes in the sandbox.
    | { readonly kind: "process"; readonly names: readonly string[] }
    // Registers an mcp__<id>__ server the agent connects to next turn.
    | { readonly kind: "mcp" }
    // Scaffolds workspace repositories; empty while a name-derived repo is still unnamed.
    | { readonly kind: "scaffold"; readonly repos: readonly string[] }
    // Writes a managed deploy.config.ts entry; `provisions` = also runs the infra apply job now (service).
    | { readonly kind: "deploy"; readonly provisions: boolean }
    // Extension code runs inside the app with the owner's session; an owner-only trust decision.
    | { readonly kind: "trusted-code" }
    // Chromium profile at .intentic/local/browser/<id>, one per account; `platform` names what it's a profile of.
    | { readonly kind: "profile"; readonly platform: string }
    // Hands on a user-owned device; `grants` are the scopes ticked on the card, enforced by its own agent.
    | { readonly kind: "machine"; readonly platform: string; readonly grants: readonly string[] }
    // The person's own browser, reached through an extension in it; its own member since the grant is bounded to sites
    // they allow one at a time, not the whole machine.
    | { readonly kind: "own-browser"; readonly platform: string; readonly grants: readonly string[] }
    // Where a conversation's turns go, nothing else changes; `url` is named to catch a typo'd host before the add.
    | { readonly kind: "endpoint"; readonly url: string }
    // Lets the agent spend real money; the only effect measured in dollars. The two ceilings are per-payment/per-day;
    // `carded` says whether every payment stops for a click or a delegated band settles automatically.
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
// Undefined until the address is a whole http(s) URL, so the row falls back rather than flickers while typing.
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
// Docker config keys living in daemon.json, not the image; setting any of them bounces dockerd on apply.
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
        // Without a contribution, secret falls back to hasSecret; the image row still waits on the contribution.
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }];
        const secret =
            input.contribution === undefined ? input.config["hasSecret"] === true : input.contribution.fields.some((field) => field.secret === true);
        if (secret) {
            effects.push({ kind: "secret", exposure: "agent-env" });
        }
        // A connector touches the image via a fragment or a named pack; the pack case is disclosed even when it may
        // cost nothing, since only the daemon can tell if it's already baked, and over-disclosing is the safe
        // direction.
        if (input.contribution?.kind === "cli" && (input.contribution.fragment !== undefined || input.contribution.pack !== undefined)) {
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
    // Disclosure follows the provider: tor asks for nothing (no account, no container privilege, since it opens its own
    // SOCKS port); tunnel providers need net-admin, and only paste-your-own (wireguard) stores a credential.
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
    // The `image` effect here is the overlay rebuild for --privileged, not new tooling; the gpu option adds real
    // tooling (container toolkit) and claims the host's GPUs, the one part the user chose.
    docker: (input) => [
        { kind: "image" },
        { kind: "runtime", level: "privileged" },
        ...(input.config["gpu"] === "on" || input.config["gpu"] === true ? [{ kind: "gpu" } as const] : []),
        // Any engine-family key set bounces dockerd on apply; shown while the user is still typing the value.
        ...(ENGINE_OPTIONS.some((key) => filled(input.config[key])) ? [{ kind: "restart", process: "dockerd" } as const] : []),
        { kind: "process", names: ["dockerd"] },
    ],
    browser: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }, { kind: "image" }];
        // Which site the stored session belongs to: a site card's `platform` slug IS the site, but a generic session's
        // card is "website", so the typed address's host stands in instead, updating live while typed.
        const site = host(input.config["homeUrl"]) ?? host(input.config["loginUrl"]) ?? input.config["platform"];
        if (typeof site === "string" && site !== "") {
            effects.push({ kind: "profile", platform: site });
        }
        // Account password, typed by the daemon, never shown to the agent; raw while adding, `hasPassword` once stored.
        if (filled(input.config["password"]) || input.config["hasPassword"] === true) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    identity: (input) => {
        const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }, { kind: "image" }];
        // The standing consequence is the identity's shared browser profile, signed into the email's own provider;
        // named by the address's domain, keeping the local part (the user's name) off the row.
        const email = filled(input.config["email"]) ? String(input.config["email"]) : "";
        const domain = email.includes("@") ? email.slice(email.indexOf("@") + 1) : "";
        effects.push({ kind: "profile", platform: domain === "" ? "email" : domain });
        // The identity's email password, typed by the daemon on the agent's behalf, never shown to it.
        if (filled(input.config["password"]) || input.config["hasPassword"] === true) {
            effects.push({ kind: "secret", exposure: "disk" });
        }
        return effects;
    },
    host: (input) => {
        // Reads are the floor, the rest are toggles; unset falls to the schema defaults the untouched form posts.
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
    webext: (input) => {
        // Reading is the floor, the rest are toggles; unset falls to the schema defaults the untouched form posts.
        const grants = [
            ...(input.config["read"] === "off" ? [] : ["read the pages you allow"]),
            ...(input.config["act"] === "off" ? [] : ["click and type on them"]),
            ...(input.config["screenshot"] === "on" ? ["take screenshots"] : []),
            ...(input.config["cookies"] === "on" ? ["hand a site's session to this sandbox"] : []),
        ];
        return [{ kind: "own-browser", platform: String(input.config["platform"] ?? ""), grants }, { kind: "skill", name: input.id }, { kind: "mcp" }];
    },
    endpoint: (input) => {
        // No `image`/`process` row: it rides the translator already in the image and already running.
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
    // The standing consequence is the server the daemon runs; the model download is disclosed on the model field
    // itself. No `endpoint` row, since turns never leave; image and gpu rows appear only when the gpu switch is on.
    localmodel: (input) => [
        { kind: "process", names: ["llama-server"] },
        ...(input.config["gpu"] === "on" || input.config["gpu"] === true ? [{ kind: "image" } as const, { kind: "gpu" } as const] : []),
    ],
    // Deliberately no `secret` row: the signing key stays with the platform's custody provider and never enters the
    // sandbox. What it adds instead is the spend itself.
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
