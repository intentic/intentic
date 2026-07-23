import type { ConnectorContribution, ExtensionManifest } from "@intentic/extension-api";
import type { CapabilityKind } from "./schemas.js";

/* What adding a capability DOES to the sandbox, as data — the structured counterpart of the handlers' side
 * effects (the sandbox's capabilities/handlers/*), rendered by the web as the "This will add to your sandbox"
 * panel before an add and as per-instance effect strips after. Derived, not declared per card: config-dependent
 * effects (a plugin's clone URL, the SQL card's engine-dependent client image) and connector/extension-declared
 * ones (secret fields, image fragments, processes) are computed from the same contribution data the handlers
 * consume, so there is no per-card effects list to drift. The streamed apply log stays the post-apply record;
 * this is the pre-add disclosure. */

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
    | { readonly kind: "profile"; readonly platform: string };

export interface CapabilityEffectInput {
    readonly kind: CapabilityKind;
    // The instance name — the skill name for cli/browser, the repo name for monorepo.
    readonly id?: string | undefined;
    // Live form values, or a CapabilitySummary's secret-stripped config echo (hasToken/hasSecret booleans).
    readonly config: Record<string, string | number | boolean | undefined>;
    // The cli provider's connector spec — the source of truth for its secret/fragment declarations.
    readonly connector?: ConnectorContribution | undefined;
    // An installed extension's manifest — resolves its process/image contributions (unknowable before install).
    readonly manifest?: ExtensionManifest | undefined;
}

const filled = (value: string | number | boolean | undefined): boolean => typeof value === "string" && value.length > 0;
// A token either typed into the form (`token`) or echoed as present on an installed instance (`hasToken`).
const hasToken = (config: CapabilityEffectInput["config"]): boolean => filled(config["token"]) || config["hasToken"] === true;
const cloneUrl = (config: CapabilityEffectInput["config"]): string | undefined => (filled(config["url"]) ? String(config["url"]) : undefined);

export const capabilityEffects = (input: CapabilityEffectInput): readonly CapabilityEffect[] => {
    switch (input.kind) {
        case "devops":
            return [{ kind: "scaffold", repos: ["intent", "desired-state"] }];
        case "monorepo":
            return [{ kind: "scaffold", repos: input.id === undefined || input.id.length === 0 ? [] : [input.id] }];
        case "mcp": {
            const effects: CapabilityEffect[] = [{ kind: "mcp" }];
            if (hasToken(input.config)) {
                effects.push({ kind: "secret", exposure: "disk" });
            }
            return effects;
        }
        case "service":
            return [{ kind: "deploy", provisions: true }];
        case "integration":
            return [{ kind: "deploy", provisions: false }];
        case "cli": {
            // Without the connector spec (extensions query pending / sandbox unreachable) fall back to the
            // echoed hasSecret — which the web also synthesizes from the card's own secret-marked fields, so
            // the secret row never waits on /extensions. The image row does wait: a connector's fragment
            // (postgres/mysql clients, discord's whisper) is spec data with no static counterpart on the card.
            const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }];
            const secret =
                input.connector === undefined ? input.config["hasSecret"] === true : input.connector.fields.some((field) => field.secret === true);
            if (secret) {
                effects.push({ kind: "secret", exposure: "agent-env" });
            }
            if (input.connector?.fragment !== undefined) {
                effects.push({ kind: "image" });
            }
            return effects;
        }
        case "plugin": {
            const effects: CapabilityEffect[] = [{ kind: "clone", url: cloneUrl(input.config) }];
            if (hasToken(input.config)) {
                effects.push({ kind: "secret", exposure: "disk" });
            }
            return effects;
        }
        case "extension": {
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
        }
        case "ssh":
            return [
                { kind: "secret", exposure: "disk" },
                { kind: "skill", name: "ssh" },
            ];
        case "vpn":
            return [{ kind: "secret", exposure: "disk" }, { kind: "skill", name: "vpn" }, { kind: "image" }, { kind: "runtime", level: "net-admin" }];
        case "docker":
            // The engine is baked into the base image — the "image" effect here is the overlay rebuild that
            // applies the fragment's --privileged directive, not new tooling.
            return [{ kind: "image" }, { kind: "runtime", level: "privileged" }, { kind: "process", names: ["dockerd"] }];
        case "browser": {
            const effects: CapabilityEffect[] = [{ kind: "skill", name: input.id }, { kind: "image" }];
            const platform = input.config["platform"];
            if (typeof platform === "string") {
                effects.push({ kind: "profile", platform });
            }
            return effects;
        }
        case "agent": {
            // The spawned ACP subprocess is the standing consequence; a pasted env block is a stored credential.
            const effects: CapabilityEffect[] = [{ kind: "process", names: input.id === undefined || input.id.length === 0 ? [] : [input.id] }];
            if (filled(input.config["env"]) || input.config["hasSecret"] === true) {
                effects.push({ kind: "secret", exposure: "disk" });
            }
            return effects;
        }
    }
};
