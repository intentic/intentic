import { describe, expect, it } from "vitest";
import { collectSecretUsage } from "./secrets.js";
import type { DesiredStateGraph, ResourceNode } from "./types.js";

const node = (id: string, type: string, inputs: ResourceNode["inputs"]): ResourceNode => ({ id, type, inputs, dependsOn: [] });
const env = (key: string) => ({ $secret: { source: "env" as const, key } });
const gen = (key: string) => ({ $secret: { source: "generated" as const, key } });

const graph: DesiredStateGraph = {
    version: 1,
    resources: {
        host: node("host", "host", { sshKey: env("HOST_SSH_KEY"), address: "203.0.113.10" }),
        // A nested env secret (inside an env map) and a $ref that must be ignored.
        app: node("app", "deployment", { server: { $ref: "host" }, env: { DATABASE_URL: env("PRODUCTION_DATABASE_URL") } }),
        // Generated secrets, plus a duplicate key (also used elsewhere) that must collapse to one entry.
        forgejo: node("forgejo", "forgejo", { adminPassword: gen("FORGEJO_ADMIN_PASSWORD") }),
        deploy: node("deploy", "komodo", { sshKey: env("HOST_SSH_KEY"), pw: gen("KOMODO_ADMIN_PASSWORD") }),
    },
};

describe("collectSecretUsage", () => {
    it("walks nested inputs into sorted entries with the referencing nodes", () => {
        expect(collectSecretUsage(graph)).toEqual([
            { key: "FORGEJO_ADMIN_PASSWORD", source: "generated", requiredBy: [{ id: "forgejo", type: "forgejo" }] },
            {
                key: "HOST_SSH_KEY",
                source: "env",
                requiredBy: [
                    { id: "deploy", type: "komodo" },
                    { id: "host", type: "host" },
                ],
            },
            { key: "KOMODO_ADMIN_PASSWORD", source: "generated", requiredBy: [{ id: "deploy", type: "komodo" }] },
            { key: "PRODUCTION_DATABASE_URL", source: "env", requiredBy: [{ id: "app", type: "deployment" }] },
        ]);
    });

    it("de-duplicates a node referencing the same key twice", () => {
        const twice: DesiredStateGraph = {
            version: 1,
            resources: { a: node("a", "x", { one: env("K"), two: env("K") }) },
        };
        expect(collectSecretUsage(twice)).toEqual([{ key: "K", source: "env", requiredBy: [{ id: "a", type: "x" }] }]);
    });

    it("throws when one key is declared under both sources (a resolver bug)", () => {
        const conflict: DesiredStateGraph = {
            version: 1,
            resources: { a: node("a", "x", { x: env("DUP") }), b: node("b", "x", { y: gen("DUP") }) },
        };
        expect(() => collectSecretUsage(conflict)).toThrow(/both/);
    });
});
