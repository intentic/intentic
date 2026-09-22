import type { CapabilityContribution } from "@intentic/extension-manifest";
import { LOCAL_MODEL_INSTANT, LOCAL_MODEL_WINDOW_DEFAULT, LOCAL_MODEL_WINDOWS, LOCAL_MODELS, localModelChoice } from "@intentic/sandbox-contract";
import { describe, it, expect } from "bun:test";
import { CAPABILITY_CATALOG, contributionEntry } from "./index.js";

// Real shapes from _extensions/connectors/intentic-extension.json, abridged to the card-relevant fields.
const postgres: CapabilityContribution = {
    id: "postgres",
    kind: "cli",
    catalog: {
        name: "PostgreSQL",
        logo: "postgresql",
        description: "Query your PostgreSQL database from the agent with psql.",
        category: "data",
        hint: "The agent queries your database with psql.",
        guide: { steps: ["No external token — use an existing DB user, ideally a read-only one."] },
    },
    fields: [
        { key: "host", label: "Host", placeholder: "db.example.com" },
        { key: "port", label: "Port", default: "5432" },
        { key: "user", label: "User", placeholder: "postgres" },
        { key: "password", label: "Password", secret: true },
        { key: "database", label: "Database", placeholder: "app" },
    ],
    env: { POSTGRES_URL: "postgresql://${user:uri}:${password:uri}@${host}:${port}/${database:uri}" },
    skill: "skills/postgres/SKILL.md",
    fragment: "env/postgres.Dockerfile",
};

const mysql: CapabilityContribution = {
    ...postgres,
    id: "mysql",
    catalog: { ...postgres.catalog, name: "MySQL", logo: "mysql" },
    fields: [
        { key: "host", label: "Host", placeholder: "db.example.com" },
        { key: "port", label: "Port", default: "3306" },
        { key: "user", label: "User", placeholder: "root" },
        { key: "password", label: "Password", secret: true },
        { key: "database", label: "Database", placeholder: "app" },
    ],
};

describe("contributionEntry", () => {
    it("derives the tile identity and fixed provider field from the contribution", () => {
        const tile = contributionEntry(postgres);
        expect(tile.id).toBe("postgres");
        expect(tile.kind).toBe("cli");
        expect(tile.name).toBe("PostgreSQL");
        expect(tile.logo).toBe("postgresql");
        expect(tile.category).toBe("data");
        expect(tile.hint).toBe(postgres.catalog.hint);
        expect(tile.guide).toBe(postgres.catalog.guide);
        expect(tile.fields[0]).toEqual({ key: "provider", label: "", value: "postgres" });
        expect(tile.fields.slice(1)).toEqual(postgres.fields);
    });

    it("keeps per-engine defaults the old merged sql tile got wrong", () => {
        const fields = contributionEntry(mysql).fields;
        expect(fields.find((field) => field.key === "port")?.default).toBe("3306");
        expect(fields.find((field) => field.key === "user")?.placeholder).toBe("root");
    });

    it("falls back to the extend category for unknown free-string categories", () => {
        const tile = contributionEntry({ ...postgres, catalog: { ...postgres.catalog, category: "totally-custom" } });
        expect(tile.category).toBe("extend");
    });

    it("leaves no static tile for any contributable kind: the catalog is extensible, the handlers are core", () => {
        // A contributable kind has no static tile; what stays is tied 1:1 to a handler it can't be separated from.
        const contributable = new Set(["cli", "browser", "host", "agent"]);
        expect(CAPABILITY_CATALOG.filter((entry) => contributable.has(entry.kind))).toEqual([]);
        expect(CAPABILITY_CATALOG.map((entry) => entry.kind).toSorted()).toEqual([
            "devops",
            "docker",
            "endpoint",
            // Static like endpoint: exit's providers are core drivers, and country pickers come from the contract's
            // tables.
            "exit",
            "extension",
            // Static for the wallet reason: the token spends the owner's account, and provisioning is core code an
            // extension must never stand in for.
            "fleet",
            // Static like endpoint: an identity has no site to vary, the email is the tile.
            "identity",
            // Static for the docker reason: the GPU switch is a privileged directive, and its handler is core code.
            "localmodel",
            "mcp",
            "monorepo",
            // Static like vpn: mounting is core code and the access switch is a fence an extension must never set.
            "netdisk",
            "plugin",
            "ssh",
            "vpn",
            // Static, strongest form: these fields are money ceilings a signer enforces; an extension must never set
            // them.
            "wallet",
        ]);
    });

    it("appends the core host scope switches to a contributed OS pack, which cannot declare them itself", () => {
        // The grant doesn't vary by OS; a pack that could restate it could also weaken it.
        const pack: CapabilityContribution = {
            id: "windows",
            kind: "device",
            catalog: { name: "Windows PC", description: "Your Windows device", category: "devices" },
            fields: [],
            skill: "skills/windows/SKILL.md",
        };
        const keys = contributionEntry(pack).fields.map((field) => field.key);
        expect(keys).toEqual(["platform", "shell", "write", "screen", "control", "sandboxes", "destructive", "roots"]);
    });

    // Renders the pinned discriminator, then the manifest's own answers, then the core credential pair every browser
    // tile gets (daemon-typed, never read by the agent).
    it("renders the generic browser tile's own fields, since the site comes from the form", () => {
        const generic: CapabilityContribution = {
            id: "website",
            kind: "browser",
            catalog: { name: "Browser session", description: "Sign into any site", category: "extend", icon: "globe" },
            fields: [
                { key: "homeUrl", label: "Page to open" },
                { key: "loginUrl", label: "Sign-in page", optional: true },
                { key: "purpose", label: "What you will use it for" },
            ],
            skill: "skills/website/SKILL.md",
        };
        const tile = contributionEntry(generic);
        // `identity` and `exit` are core facts (which browser, which country) that no site tile can override.
        expect(tile.fields.map((field) => field.key)).toEqual([
            "platform",
            "homeUrl",
            "loginUrl",
            "purpose",
            "username",
            "password",
            "identity",
            "exit",
        ]);
        // Offered only to an account with its own profile; one under an identity uses that identity's exit instead.
        expect(tile.fields.find((field) => field.key === "exit")?.when).toBe("!identity");
        expect(tile.fields[0]).toEqual({ key: "platform", label: "", value: "website" });
        // Optional and secret: required would demand a password from someone who signs in by hand.
        expect(tile.fields.find((field) => field.key === "password")).toMatchObject({ secret: true, optional: true });
        // No brand to borrow: it stands for whatever site the user points it at, so it carries a glyph instead.
        expect(tile.logo).toBeUndefined();
        expect(tile.icon).toBe("globe");
    });

    it("does not duplicate a credential field the browser tile declares itself", () => {
        const declaring: CapabilityContribution = {
            id: "customsite",
            kind: "browser",
            catalog: { name: "Custom", description: "Site with its own username field", category: "extend", icon: "globe" },
            fields: [{ key: "username", label: "Login handle" }],
            loginUrl: "https://example.com/login",
            homeUrl: "https://example.com/",
            skill: "skills/customsite/SKILL.md",
        };
        const keys = contributionEntry(declaring).fields.map((field) => field.key);
        expect(keys).toEqual(["platform", "username", "password", "identity", "exit"]);
        expect(contributionEntry(declaring).fields.find((field) => field.key === "username")?.label).toBe("Login handle");
    });

    it("pins no discriminator for a preset kind, whose tiles differ only in their defaults", () => {
        const preset: CapabilityContribution = {
            id: "opencode",
            kind: "agent",
            catalog: { name: "OpenCode", description: "ACP chat provider", category: "extend" },
            fields: [{ key: "command", label: "Command", default: "opencode acp" }],
        };
        expect(contributionEntry(preset).fields.map((field) => field.key)).toEqual(["command"]);
    });
});

// Pins that the context window and its price labels never drift apart, quoting one number while serving another.
describe("the local model tile", () => {
    const tile = CAPABILITY_CATALOG.find((entry) => entry.id === "localmodel")!;
    const field = (key: string) => tile.fields.find((entry) => entry.key === key);

    it("prices every window rung and defaults to one of them", () => {
        const options = field("context")?.options ?? [];
        // Every rung the schema accepts is offered in order, with the typed escape hatch last.
        expect(options.map((option) => option.value)).toEqual([...LOCAL_MODEL_WINDOWS, "custom"]);
        // Every rung carries its price, so the choice is actually informed.
        for (const option of options.filter((entry) => entry.value !== "custom")) {
            expect(option.label).toMatch(/\d+k · \d+ GB/);
        }
        expect(field("context")?.default).toBe(LOCAL_MODEL_WINDOW_DEFAULT);
        expect<readonly unknown[]>(LOCAL_MODEL_WINDOWS).toContain(field("context")?.default);
    });

    // The smallest rung a full agent turn fits in, per the contract; under it, downloads and serves a useless model.
    it("defaults to a window a full agent turn fits in", () => {
        expect(Number(LOCAL_MODEL_WINDOW_DEFAULT)).toBeGreaterThanOrEqual(65_536);
    });

    // Weights only: folding the cache back in would recreate the coupling that made the window unofferable.
    it("quotes the weights on the model field, never a total", () => {
        for (const option of field("model")?.options?.filter((entry) => entry.value !== "custom") ?? []) {
            expect(option.label).toMatch(/weights \d+(\.\d)? GB/);
        }
    });

    // The tile offers the contract's list and nothing else: a row added there must not need a second edit here to be
    // offerable, which is the drift that let the old hand-written labels overstate two models.
    it("offers every curated model, plus the custom escape hatch last", () => {
        expect(field("model")?.options?.map((option) => option.value)).toEqual([...LOCAL_MODELS.map((choice) => choice.id), "custom"]);
        // The default is a curated row, and never the instant one: a default that downloads in a minute and cannot hold
        // a full turn is the wrong thing to hand someone who accepted the form untouched.
        expect(localModelChoice(String(field("model")?.default))?.tier).toBe("work");
    });

    // The instant rung is the one the connect view prefetches; it cannot hold a full turn, and its own label has to say
    // so wherever it is offered.
    it("marks the instant rung as quick jobs only", () => {
        const instant = field("model")?.options?.find((option) => option.value === LOCAL_MODEL_INSTANT.id);
        expect(instant?.label).toContain("quick jobs only");
    });

    it("asks for a typed window only when the rungs are declined", () => {
        expect(field("contextTokens")?.when).toBe("context == 'custom'");
    });
});
