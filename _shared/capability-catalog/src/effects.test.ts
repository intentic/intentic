import type { CapabilityContribution, ExtensionManifest } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import { capabilityEffects } from "./effects.js";
import { CapabilityKindSchema } from "@intentic/sandbox-contract";

// The cli arm specifically; `Partial<CapabilityContribution>` over the discriminated union would let an override widen
// `kind` back to the whole union.
type CliContribution = Extract<CapabilityContribution, { kind: "cli" }>;

const connector = (overrides?: Partial<CliContribution>): CliContribution => ({
    id: "github",
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

    it("a local model runs a process, and only its gpu switch costs an image and the host's GPUs", () => {
        expect(capabilityEffects({ kind: "localmodel", config: { model: "owner/repo/m.gguf" } })).toEqual([
            { kind: "process", names: ["llama-server"] },
        ]);
        expect(capabilityEffects({ kind: "localmodel", config: { model: "owner/repo/m.gguf", gpu: "on" } })).toEqual([
            { kind: "process", names: ["llama-server"] },
            { kind: "image" },
            { kind: "gpu" },
        ]);
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
        const github = capabilityEffects({ kind: "cli", id: "github", config: { provider: "github" }, contribution: connector() });
        expect(github).toEqual([
            { kind: "skill", name: "github" },
            { kind: "secret", exposure: "agent-env" },
        ]);
        const postgres = capabilityEffects({
            kind: "cli",
            id: "db",
            config: { provider: "postgres" },
            contribution: connector({ id: "postgres", fragment: "env/postgres.Dockerfile" }),
        });
        expect(postgres).toContainEqual({ kind: "image" });
        // Discord names a pack, not a fragment; that still triggers the image effect the same way.
        const discord = capabilityEffects({
            kind: "cli",
            id: "discord",
            config: { provider: "discord" },
            contribution: connector({ id: "discord", pack: "whisper" }),
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

    it("discloses the model endpoint's destination, and claims no rebuild or process", () => {
        expect(capabilityEffects({ kind: "endpoint", config: { baseUrl: "http://host.docker.internal:11434/v1" } })).toEqual([
            { kind: "endpoint", url: "http://host.docker.internal:11434/v1" },
        ]);
        // Named as soon as the field is filled, even before typing (empty url), so the disclosure reads before the add.
        expect(capabilityEffects({ kind: "endpoint", config: {} })).toEqual([{ kind: "endpoint", url: "" }]);
        // A key is the ordinary second effect, whether from the live form or an installed instance's echo.
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

    it("spells out what a connected device grants, defaulting writes OFF", () => {
        // An untouched form posts nothing for the switches, so the defaults are the disclosure the user reads.
        expect(capabilityEffects({ kind: "host", id: "laptop", config: { platform: "windows" } })).toEqual([
            { kind: "machine", platform: "windows", grants: ["run commands", "read files", "capture the screen"] },
            { kind: "skill", name: "laptop" },
            { kind: "mcp" },
        ]);
    });

    it("follows the switches the user set on a connected device", () => {
        const [machine] = capabilityEffects({
            kind: "host",
            id: "desktop",
            config: { platform: "linux", shell: "off", write: "on", screen: "off", sandboxes: "on" },
        });
        expect(machine).toEqual({
            kind: "machine",
            platform: "linux",
            grants: ["read files", "write and trash files", "start and stop its sandboxes"],
        });
    });

    it("keeps a browser profile per connected account", () => {
        expect(capabilityEffects({ kind: "browser", id: "reddit-work", config: { platform: "reddit" } })).toEqual([
            { kind: "skill", name: "reddit-work" },
            { kind: "image" },
            { kind: "profile", platform: "reddit" },
        ]);
    });

    // A password reaches config either as a raw `password` value while adding, or as a masked `hasPassword` echo for an
    // already-stored entry.
    it("discloses a browser account's stored password as a secret", () => {
        expect(capabilityEffects({ kind: "browser", id: "reddit-work", config: { platform: "reddit", password: "s3cret!" } })).toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
        expect(capabilityEffects({ kind: "browser", id: "reddit-work", config: { platform: "reddit", hasPassword: true } })).toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
        expect(capabilityEffects({ kind: "browser", id: "reddit-work", config: { platform: "reddit" } })).not.toContainEqual({
            kind: "secret",
            exposure: "disk",
        });
    });

    // For a generic `website` session, the profile is named by the host parsed from the typed address, not by the card.
    it("names the site a generic browser session points at", () => {
        const [, , profile] = capabilityEffects({
            kind: "browser",
            id: "acme",
            config: { platform: "website", homeUrl: "https://admin.acme.com/dashboard" },
        });
        expect(profile).toEqual({ kind: "profile", platform: "admin.acme.com" });
    });

    // Falls back to "website" when the address can't be parsed at all (missing scheme, or empty); a host with no dot
    // isn't special-cased, since that would break `localhost:3000` and LAN hostnames.
    it("falls back to the card when the address cannot be read at all", () => {
        const bare = capabilityEffects({ kind: "browser", id: "acme", config: { platform: "website", homeUrl: "admin.acme.com" } });
        expect(bare[2]).toEqual({ kind: "profile", platform: "website" });
        const empty = capabilityEffects({ kind: "browser", id: "acme", config: { platform: "website", homeUrl: "" } });
        expect(empty[2]).toEqual({ kind: "profile", platform: "website" });
    });

    it("keeps a schemeless-looking but valid host, port and all", () => {
        const [, , profile] = capabilityEffects({
            kind: "browser",
            id: "panel",
            config: { platform: "website", homeUrl: "http://localhost:3000/admin" },
        });
        expect(profile).toEqual({ kind: "profile", platform: "localhost:3000" });
    });

    it("reads the site off the sign-in page when that is all there is", () => {
        const [, , profile] = capabilityEffects({
            kind: "browser",
            id: "acme",
            config: { platform: "website", loginUrl: "https://id.acme.com/signin" },
        });
        expect(profile).toEqual({ kind: "profile", platform: "id.acme.com" });
    });
});
