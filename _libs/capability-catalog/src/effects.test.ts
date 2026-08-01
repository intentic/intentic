import type { ConnectorContribution, ExtensionManifest } from "@intentic/extension-api";
import { describe, expect, it } from "vitest";
import { capabilityEffects } from "./effects.js";
import { CapabilityKindSchema } from "@intentic/sandbox-contract";

const connector = (overrides?: Partial<ConnectorContribution>): ConnectorContribution => ({
    provider: "github",
    kind: "cli",
    catalog: { name: "GitHub", description: "Issues and PRs.", category: "code" },
    fields: [{ key: "token", label: "Token", secret: true }],
    env: { GITHUB_TOKEN: "${token}" },
    skill: "skills/github/SKILL.md",
    ...overrides,
});

const manifest = (contributes: ExtensionManifest["contributes"]): ExtensionManifest => ({
    publisher: "acme",
    name: "tools",
    version: "1.0.0",
    engines: { intentic: "^0.2.0" },
    contributes,
});

describe("capabilityEffects", () => {
    // Pins the CapabilityKind union to the deriver: a 13th kind must declare its effects to pass.
    it("yields at least one effect for every kind", () => {
        for (const kind of CapabilityKindSchema.options) {
            expect(capabilityEffects({ kind, config: {} }).length).toBeGreaterThan(0);
        }
    });

    it("interpolates the plugin clone url and token from form state and from the echo", () => {
        expect(capabilityEffects({ kind: "plugin", config: {} })).toEqual([{ kind: "clone", url: undefined }]);
        expect(capabilityEffects({ kind: "plugin", config: { url: "https://github.com/o/p", token: "t" } })).toEqual([
            { kind: "clone", url: "https://github.com/o/p" },
            { kind: "secret", exposure: "disk" },
        ]);
        expect(capabilityEffects({ kind: "plugin", config: { url: "https://github.com/o/p", hasToken: true } })).toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
    });

    it("stores an mcp token only when one is present", () => {
        expect(capabilityEffects({ kind: "mcp", config: { url: "https://mcp.example.com" } })).toEqual([{ kind: "mcp" }]);
        expect(capabilityEffects({ kind: "mcp", config: { url: "https://mcp.example.com", token: "t" } })).toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
    });

    it("always stores an ssh credential on disk, for both auth modes", () => {
        for (const auth of ["key", "password"]) {
            expect(capabilityEffects({ kind: "ssh", config: { auth } })).toEqual([
                { kind: "secret", exposure: "disk" },
                { kind: "skill", name: "ssh" },
            ]);
        }
    });

    it("scaffolds the monorepo under the instance name", () => {
        expect(capabilityEffects({ kind: "monorepo", id: "shop", config: {} })).toEqual([{ kind: "scaffold", repos: ["shop"] }]);
        expect(capabilityEffects({ kind: "monorepo", config: {} })).toEqual([{ kind: "scaffold", repos: [] }]);
    });

    it("derives cli secret and image from the connector spec", () => {
        const github = capabilityEffects({ kind: "cli", id: "github", config: { provider: "github" }, connector: connector() });
        expect(github).toEqual([
            { kind: "skill", name: "github" },
            { kind: "secret", exposure: "agent-env" },
        ]);
        const postgres = capabilityEffects({
            kind: "cli",
            id: "db",
            config: { provider: "postgres" },
            connector: connector({ provider: "postgres", fragment: "env/postgres.Dockerfile" }),
        });
        expect(postgres).toContainEqual({ kind: "image" });
        // Discord's whisper fragment is connector spec data like any other — the image effect derives from it.
        const discord = capabilityEffects({
            kind: "cli",
            id: "discord",
            config: { provider: "discord" },
            connector: connector({ provider: "discord", fragment: "env/whisper.Dockerfile" }),
        });
        expect(discord).toContainEqual({ kind: "image" });
    });

    it("falls back to the echoed hasSecret when no connector spec is at hand", () => {
        expect(capabilityEffects({ kind: "cli", id: "github", config: { provider: "github", hasSecret: true } })).toContainEqual({
            kind: "secret",
            exposure: "agent-env",
        });
        expect(capabilityEffects({ kind: "cli", id: "github", config: { provider: "github" } })).toEqual([{ kind: "skill", name: "github" }]);
    });

    it("derives extension process and image effects from the installed manifest", () => {
        const bare = capabilityEffects({ kind: "extension", config: { url: "https://github.com/o/e" } });
        expect(bare).toEqual([{ kind: "trusted-code" }, { kind: "clone", url: "https://github.com/o/e" }]);
        const full = capabilityEffects({
            kind: "extension",
            config: { url: "https://github.com/o/e", hasToken: true },
            manifest: manifest({
                processes: [{ name: "gateway", command: "node gateway.js" }],
                environment: { fragment: "env/tools.Dockerfile" },
            }),
        });
        expect(full).toContainEqual({ kind: "secret", exposure: "disk" });
        expect(full).toContainEqual({ kind: "image" });
        expect(full).toContainEqual({ kind: "process", names: ["gateway"] });
    });

    /* An endpoint's whole consequence is WHERE the turns go — it rides the translator that is already baked and
     * already running, so it needs no rebuild and starts nothing. The panel claiming either would be teaching the
     * user to expect a rebuild prompt that never comes. */
    it("discloses the model endpoint's destination, and claims no rebuild or process", () => {
        expect(capabilityEffects({ kind: "endpoint", config: { baseUrl: "http://host.docker.internal:11434/v1" } })).toEqual([
            { kind: "endpoint", url: "http://host.docker.internal:11434/v1" },
        ]);
        // Named the moment the field is filled, so the disclosure can be read BEFORE the add — including the
        // pre-typing state, where it still has to say what will leave.
        expect(capabilityEffects({ kind: "endpoint", config: {} })).toEqual([{ kind: "endpoint", url: "" }]);
        // A key is the ordinary second effect, from the live form or from an installed instance's echo.
        expect(capabilityEffects({ kind: "endpoint", config: { baseUrl: "https://gw.example.com/v1", apiKey: "sk-x" } })).toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
        expect(capabilityEffects({ kind: "endpoint", config: { baseUrl: "https://gw.example.com/v1", hasSecret: true } })).toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
    });

    it("marks vpn as a privileged-runtime image change", () => {
        expect(capabilityEffects({ kind: "vpn", config: {} })).toContainEqual({ kind: "runtime", level: "net-admin" });
    });

    it("marks docker as a fully privileged runtime rebuild running dockerd", () => {
        expect(capabilityEffects({ kind: "docker", config: {} })).toEqual([
            { kind: "image" },
            { kind: "runtime", level: "privileged" },
            { kind: "process", names: ["dockerd"] },
        ]);
    });

    it("spells out what a connected computer grants, defaulting writes OFF", () => {
        // An untouched form posts nothing for the switches, so the defaults ARE the disclosure the user reads.
        expect(capabilityEffects({ kind: "host", id: "laptop", config: { platform: "windows" } })).toEqual([
            { kind: "machine", platform: "windows", grants: ["run commands", "read files", "capture the screen"] },
            { kind: "skill", name: "laptop" },
            { kind: "mcp" },
        ]);
    });

    it("follows the switches the user set on a connected computer", () => {
        const [machine] = capabilityEffects({
            kind: "host",
            id: "desktop",
            config: { platform: "linux", shell: "off", write: "on", screen: "off" },
        });
        expect(machine).toEqual({ kind: "machine", platform: "linux", grants: ["read files", "write and trash files"] });
    });

    it("keeps a browser profile per platform", () => {
        expect(capabilityEffects({ kind: "browser", id: "reddit", config: { platform: "reddit" } })).toEqual([
            { kind: "skill", name: "reddit" },
            { kind: "image" },
            { kind: "profile", platform: "reddit" },
        ]);
    });
});
