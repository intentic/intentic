import type { InventoryEntry } from "@intentic/sandbox-contract";
import { describe, expect, test } from "vitest";
import { readManagedRegion, scaffoldDeployConfig, writeManagedRegion } from "./deploy-config.js";

const hostEntry: InventoryEntry = { kind: "backend", provider: "host", name: "self", values: { address: "1.2.3.4", user: "deploy", port: 22 } };
const cfEntry: InventoryEntry = { kind: "backend", provider: "cloudflare", name: "cf", values: {} };
const signozEntry: InventoryEntry = {
    kind: "service",
    service: "signoz",
    name: "obs",
    on: "self",
    expose: "cf",
    values: { domain: "signoz.example.com" },
};

describe("deploy-config managed region", () => {
    test("a scaffold has an empty managed region", () => {
        expect(readManagedRegion(scaffoldDeployConfig([]))).toEqual([]);
    });

    test("the neutral scaffold declares no host and no app", () => {
        const src = scaffoldDeployConfig([]);
        expect(src).toContain("// <intentic> managed");
        expect(src).toContain("defineIntent");
        // Keeps both imports so the file stays valid the moment /inventory inserts an env()-bearing backend.
        expect(src).toContain(`import { env } from "@intentic/graph"`);
        expect(src).not.toContain("i.have.host(");
        expect(src).not.toContain("i.want.app(");
        expect(src).not.toContain("203.0.113.10");
        expect(src).not.toContain("on: self");
    });

    test("round-trips a backend entry, dropping its secret (env) fields from the parsed values", () => {
        const src = scaffoldDeployConfig([hostEntry]);
        // The rendered host carries sshKey: env("HOST_SSH_KEY"); the parser surfaces only the non-secret scalars.
        expect(src).toContain(`sshKey: env("HOST_SSH_KEY")`);
        expect(readManagedRegion(src)).toEqual([
            { kind: "backend", provider: "host", name: "self", values: { address: "1.2.3.4", user: "deploy", port: 22 } },
        ]);
    });

    test("a non-self host reads its OWN ssh-key env var (<NAME>_SSH_KEY); self keeps HOST_SSH_KEY", () => {
        const prod = { kind: "backend", provider: "host", name: "prod", values: { address: "203.0.113.10", user: "deploy", port: 22 } } as const;
        const src = scaffoldDeployConfig([prod]);
        expect(src).toContain(`sshKey: env("PROD_SSH_KEY")`);
        expect(src).not.toContain(`HOST_SSH_KEY`);
        expect(readManagedRegion(src)).toEqual([prod]);
    });

    test("round-trips the cloudflare zone picked at connect time (token stays an env() secret)", () => {
        const entry: InventoryEntry = { kind: "backend", provider: "cloudflare", name: "cf", values: { zone: "example.com" } };
        const src = scaffoldDeployConfig([entry]);
        expect(src).toContain(`apiToken: env("CLOUDFLARE_API_TOKEN")`);
        expect(src).toContain(`zone: "example.com"`);
        expect(readManagedRegion(src)).toEqual([entry]);
    });

    test("round-trips a service losslessly (on/expose stay bare-name refs, domain stays a value)", () => {
        const src = scaffoldDeployConfig([signozEntry]);
        expect(src).toContain(`on: self`);
        expect(src).toContain(`expose: cf`);
        expect(readManagedRegion(src)).toEqual([signozEntry]);
    });

    test("round-trips every catalog service kind, not just signoz", () => {
        const entries: InventoryEntry[] = ([`outline`, `paperless`, `openproject`] as const).map((service) => ({
            kind: `service`,
            service,
            name: service,
            on: `self`,
            expose: `cf`,
            values: { domain: `${service}.example.com` },
        }));
        expect(readManagedRegion(scaffoldDeployConfig(entries))).toEqual(entries);
    });

    test("writeManagedRegion replaces the region in place and is stable across repeated writes", () => {
        const once = writeManagedRegion(scaffoldDeployConfig([]), [hostEntry, cfEntry, signozEntry]);
        const twice = writeManagedRegion(once, readManagedRegion(once));
        expect(twice).toBe(once);
        expect(readManagedRegion(twice)).toEqual([hostEntry, cfEntry, signozEntry]);
    });

    test("preserves user code outside the managed markers", () => {
        const src = [
            `import { env } from "@intentic/graph";`,
            `import { defineIntent } from "@intentic/sdk";`,
            ``,
            `export const intent = defineIntent((i) => {`,
            `    // <intentic> managed — do not edit by hand`,
            `    const self = i.have.host("self", { address: "1.2.3.4", user: "deploy", port: 22, sshKey: env("HOST_SSH_KEY") });`,
            `    // </intentic>`,
            `    i.want.app("web", { on: self, expose: cf, environments: {} });`,
            `});`,
            ``,
        ].join(`\n`);
        const rewritten = writeManagedRegion(src, []);
        expect(rewritten).toContain(`i.want.app("web"`);
        expect(readManagedRegion(rewritten)).toEqual([]);
    });

    test("skips declarations for providers it does not model", () => {
        const src = scaffoldDeployConfig([]).replace(`// </intentic>`, `    const x = i.have.mystery("x", { foo: "bar" });\n    // </intentic>`);
        expect(readManagedRegion(src)).toEqual([]);
    });
});

describe("app entries", () => {
    const appEntry: InventoryEntry = { kind: "app", name: "shop", on: "self", expose: "cf", values: { domain: "shop.example.com" } };

    test("round-trips an app losslessly (on/expose stay bare-name refs, domain lives in the production environment)", () => {
        const src = scaffoldDeployConfig([hostEntry, cfEntry, appEntry]);
        expect(src).toContain(`const shop = i.want.app("shop"`);
        expect(src).toContain(`on: self`);
        expect(src).toContain(`expose: cf`);
        expect(src).toContain(`environments: { production: { domain: "shop.example.com", branch: "main" } }`);
        expect(readManagedRegion(src)).toEqual([hostEntry, cfEntry, appEntry]);
    });

    test("an app on a non-default host references that host's binding", () => {
        const prod = { kind: "backend", provider: "host", name: "radarsu_deploy", values: { address: "1.2.3.4", user: "deploy", port: 22 } } as const;
        const entry: InventoryEntry = { kind: "app", name: "shop", on: "radarsu_deploy", expose: "cf", values: { domain: "shop.example.com" } };
        const src = scaffoldDeployConfig([prod, cfEntry, entry]);
        expect(src).toContain(`i.want.app("shop", { on: radarsu_deploy,`);
        expect(readManagedRegion(src)).toEqual([prod, cfEntry, entry]);
    });

    test("a hand-authored i.want.app outside the markers is preserved but not parsed", () => {
        const src = writeManagedRegion(scaffoldDeployConfig([appEntry]), [appEntry]).replace(
            `});\n`,
            `    i.want.app("legacy", { on: self, expose: cf, environments: {} });\n});\n`,
        );
        expect(readManagedRegion(src)).toEqual([appEntry]);
    });
});
