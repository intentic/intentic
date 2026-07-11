import type { IntentSet } from "@intentic/need-resolver";
import { expect, test } from "vitest";

import { collectDomains, selectZone } from "./zone.js";

const intent = (apps: IntentSet["apps"], services: IntentSet["services"] = []): IntentSet => ({ hosts: [], users: [], teams: [], apps, services });

test("collectDomains gathers every app-environment and service domain", () => {
    const set = intent(
        [
            {
                id: "app",
                on: "host",
                expose: "cf",
                environments: {
                    staging: { domain: "staging.example.com", branch: "develop" },
                    production: { domain: "app.example.com", branch: "main" },
                },
            },
        ],
        [{ id: "obs", kind: "signoz", on: "host", expose: "cf", domain: "signoz.example.com" }],
    );
    expect(collectDomains(set).toSorted()).toEqual(["app.example.com", "signoz.example.com", "staging.example.com"]);
});

test("selectZone matches the apex and subdomains to their zone", () => {
    expect(selectZone(["example.com", "other.com"], ["app.example.com", "staging.example.com"])).toBe("example.com");
    expect(selectZone(["example.com"], ["example.com"])).toBe("example.com");
});

test("selectZone picks the most specific (longest) matching zone for subdomain zones", () => {
    expect(selectZone(["example.com", "eng.example.com"], ["api.eng.example.com"])).toBe("eng.example.com");
});

test("selectZone matches only on a label boundary", () => {
    expect(() => selectZone(["example.com"], ["notexample.com"])).toThrow(/not under any zone/);
});

test("selectZone falls back to the token's single zone when no domains are declared", () => {
    expect(selectZone(["example.com"], [])).toBe("example.com");
});

test("selectZone is ambiguous with no domains and multiple zones", () => {
    expect(() => selectZone(["example.com", "other.com"], [])).toThrow(/ambiguous/);
});

test("selectZone rejects domains that span more than one zone", () => {
    expect(() => selectZone(["example.com", "other.com"], ["app.example.com", "app.other.com"])).toThrow(/single Cloudflare zone/);
});

test("selectZone throws when the token sees no zones", () => {
    expect(() => selectZone([], ["app.example.com"])).toThrow(/no zones/);
});
