import type { ConnectorContribution } from "@intentic/extension-api";
import { describe, expect, it } from "vitest";
import { CAPABILITY_CATALOG, connectorCard } from "./index.js";

// The real shapes from _extensions/connectors/intentic-extension.json, abridged to the card-relevant data —
// pins that the derived per-engine cards keep the manifest defaults the old merged "sql" card got wrong
// (mysql on port 5432 / user postgres).
const postgres: ConnectorContribution = {
    provider: "postgres",
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

const mysql: ConnectorContribution = {
    ...postgres,
    provider: "mysql",
    catalog: { ...postgres.catalog, name: "MySQL", logo: "mysql" },
    fields: [
        { key: "host", label: "Host", placeholder: "db.example.com" },
        { key: "port", label: "Port", default: "3306" },
        { key: "user", label: "User", placeholder: "root" },
        { key: "password", label: "Password", secret: true },
        { key: "database", label: "Database", placeholder: "app" },
    ],
};

describe("connectorCard", () => {
    it("derives the card identity and fixed provider field from the contribution", () => {
        const card = connectorCard(postgres);
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
        const fields = connectorCard(mysql).fields;
        expect(fields.find((field) => field.key === "port")?.default).toBe("3306");
        expect(fields.find((field) => field.key === "user")?.placeholder).toBe("root");
    });

    it("falls back to the extend category for unknown free-string categories", () => {
        const card = connectorCard({ ...postgres, catalog: { ...postgres.catalog, category: "totally-custom" } });
        expect(card.category).toBe("extend");
    });

    it("leaves no static cli cards to shadow derived ones", () => {
        expect(CAPABILITY_CATALOG.filter((entry) => entry.kind === "cli")).toEqual([]);
    });
});
