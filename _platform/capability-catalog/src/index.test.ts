import type { CapabilityContribution } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import { CAPABILITY_CATALOG, contributionCard } from "./index.js";

// The real shapes from _extensions/connectors/intentic-extension.json, abridged to the card-relevant data —
// pins that the derived per-engine cards keep the manifest defaults the old merged "sql" card got wrong
// (mysql on port 5432 / user postgres).
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

describe("contributionCard", () => {
    it("derives the card identity and fixed provider field from the contribution", () => {
        const card = contributionCard(postgres);
        expect(card.id).toBe("postgres");
        expect(card.kind).toBe("cli");
        expect(card.name).toBe("PostgreSQL");
        expect(card.logo).toBe("postgresql");
        expect(card.category).toBe("data");
        expect(card.hint).toBe(postgres.catalog.hint);
        expect(card.guide).toBe(postgres.catalog.guide);
        expect(card.fields[0]).toEqual({ key: "provider", label: "", value: "postgres" });
        expect(card.fields.slice(1)).toEqual(postgres.fields);
    });

    it("keeps per-engine defaults the old merged sql card got wrong", () => {
        const fields = contributionCard(mysql).fields;
        expect(fields.find((field) => field.key === "port")?.default).toBe("3306");
        expect(fields.find((field) => field.key === "user")?.placeholder).toBe("root");
    });

    it("falls back to the extend category for unknown free-string categories", () => {
        const card = contributionCard({ ...postgres, catalog: { ...postgres.catalog, category: "totally-custom" } });
        expect(card.category).toBe("extend");
    });

    it("leaves no static card for any contributable kind — the catalog is extensible, the handlers are core", () => {
        // The boundary the extraction exists to hold: a kind an extension can supply a card for has NO static
        // card, so there is exactly one place a card of that kind comes from. What stays is one-to-one with a
        // handler it can't be separated from (docker's --privileged, vpn's NET_ADMIN, extension's own installer).
        const contributable = new Set(["cli", "browser", "host", "agent"]);
        expect(CAPABILITY_CATALOG.filter((entry) => contributable.has(entry.kind))).toEqual([]);
        expect(CAPABILITY_CATALOG.map((entry) => entry.kind).toSorted()).toEqual(
            ["devops", "docker", "endpoint", "extension", "integration", "mcp", "monorepo", "plugin", "ssh", "vpn"],
        );
    });

    it("appends the core host scope switches to a contributed OS pack, which cannot declare them itself", () => {
        // The grant does not vary by OS, so a platform pack that could restate it is one that could weaken it.
        const pack: CapabilityContribution = {
            id: "windows",
            kind: "host",
            catalog: { name: "Windows PC", description: "Your Windows computer", category: "machines" },
            fields: [],
            skill: "skills/windows/SKILL.md",
        };
        const keys = contributionCard(pack).fields.map((field) => field.key);
        expect(keys).toEqual(["platform", "shell", "write", "screen", "control", "sandboxes", "sandboxRemove", "roots"]);
    });

    it("pins no discriminator for a preset kind, whose cards differ only in their defaults", () => {
        const preset: CapabilityContribution = {
            id: "opencode",
            kind: "agent",
            catalog: { name: "OpenCode", description: "ACP chat provider", category: "extend" },
            fields: [{ key: "command", label: "Command", default: "opencode acp" }],
        };
        expect(contributionCard(preset).fields.map((field) => field.key)).toEqual(["command"]);
    });
});
