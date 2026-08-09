import type { CapabilityContribution, ExtensionManifest } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import { capabilityEffects } from "./effects.js";
import { CapabilityKindSchema } from "@intentic/sandbox-contract";

// The cli arm specifically: the fixture is a connector spec, and `Partial<CapabilityContribution>` over the
// discriminated union would let an override widen `kind` back to the whole union.
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
        // Discord's whisper fragment is connector spec data like any other — the image effect derives from it.
        const discord = capabilityEffects({
            kind: "cli",
            id: "discord",
            config: { provider: "discord" },
            contribution: connector({ id: "discord", fragment: "env/whisper.Dockerfile" }),
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
            config: { platform: "linux", shell: "off", write: "on", screen: "off", sandboxes: "on" },
        });
        expect(machine).toEqual({
            kind: "machine",
            platform: "linux",
            grants: ["read files", "write and trash files", "start and stop its sandboxes"],
        });
    });

    // One profile per CONNECTION, named after the site it is a profile of — so a second account of that site
    // discloses its own stored session rather than looking like a second row about the first one's.
    it("keeps a browser profile per connected account", () => {
        expect(capabilityEffects({ kind: "browser", id: "reddit-work", config: { platform: "reddit" } })).toEqual([
            { kind: "skill", name: "reddit-work" },
            { kind: "image" },
            { kind: "profile", platform: "reddit" },
        ]);
    });

    /* A GENERIC SESSION'S ROW NAMES THE SITE, not the card. "Keeps a logged-in website browser profile" would be
     * true of nothing in particular, on the one row where the user decides whether to store a session and a
     * passkey at all — so the address they typed is read down to its host and stands in. */
    it("names the site a generic browser session points at", () => {
        const [, , profile] = capabilityEffects({
            kind: "browser",
            id: "acme",
            config: { platform: "website", homeUrl: "https://admin.acme.com/dashboard" },
        });
        expect(profile).toEqual({ kind: "profile", platform: "admin.acme.com" });
    });

    /* The row is live while the address is being typed, and the fallback is for what cannot be read as an address
     * AT ALL — empty, or a host with no scheme. A partial host is deliberately NOT special-cased: the only rule
     * that would catch "https://adm" is "a host needs a dot", and that would throw away `localhost:3000` and a
     * LAN hostname — which are precisely the internal admin panels this card exists for. */
    it("falls back to the card when the address cannot be read at all", () => {
        const bare = capabilityEffects({ kind: "browser", id: "acme", config: { platform: "website", homeUrl: "admin.acme.com" } });
        expect(bare[2]).toEqual({ kind: "profile", platform: "website" });
        const empty = capabilityEffects({ kind: "browser", id: "acme", config: { platform: "website", homeUrl: "" } });
        expect(empty[2]).toEqual({ kind: "profile", platform: "website" });
    });

    // A host with no dot is a real answer, not a typo — an internal panel on the sandbox's own machine.
    it("keeps a schemeless-looking but valid host, port and all", () => {
        const [, , profile] = capabilityEffects({
            kind: "browser",
            id: "panel",
            config: { platform: "website", homeUrl: "http://localhost:3000/admin" },
        });
        expect(profile).toEqual({ kind: "profile", platform: "localhost:3000" });
    });

    // The sign-in page answers it when that is the only address given.
    it("reads the site off the sign-in page when that is all there is", () => {
        const [, , profile] = capabilityEffects({
            kind: "browser",
            id: "acme",
            config: { platform: "website", loginUrl: "https://id.acme.com/signin" },
        });
        expect(profile).toEqual({ kind: "profile", platform: "id.acme.com" });
    });
});
