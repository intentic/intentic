import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { CONNECT_TOKEN_HEADER } from "./headers.js";
import { ingressPath, PLATFORM_INGRESS, TRIAL_MODEL_API_PATH } from "./routes.js";
import {
    AdoptionBodySchema,
    AnnounceBodySchema,
    BootReportBodySchema,
    FarewellBodySchema,
    FleetProvisionBodySchema,
    ingressRefusalOf,
    LocalDnsBodySchema,
    SetupClaimFormSchema,
    SetupReportBodySchema,
} from "./ingress-schemas.js";

// The bodies machines of earlier releases send, byte for byte as their code builds them: a platform of this release
// must keep reading every one (COMPATIBILITY.md, "Across versions").
describe("bodies an older machine sends still parse", () => {
    it("an announce from a daemon that names nothing but its address", () => {
        expect(AnnounceBodySchema.parse({ daemonUrl: "https://abc123def456.intentic.dev" })).toEqual({ daemonUrl: "https://abc123def456.intentic.dev" });
    });

    it("an announce whose labels it cannot read keeps the announce and drops the labels", () => {
        const body = { daemonUrl: "https://abc123def456.intentic.dev", version: 7, instance: "", host: "x".repeat(500), os: " windows ", extra: 1 };
        expect(AnnounceBodySchema.parse(body)).toEqual({ daemonUrl: "https://abc123def456.intentic.dev", os: "windows" });
    });

    it("an announce at an address that is not https is refused", () => {
        expect(AnnounceBodySchema.safeParse({ daemonUrl: "http://abc123def456.intentic.dev" }).success).toBe(false);
    });

    it("a boot report from before `retrying`, `boot`, `cpu` and `drift`", () => {
        expect(BootReportBodySchema.parse({ reach: "unreachable", detail: "no tunnel" })).toEqual({ reach: "unreachable", detail: "no tunnel" });
    });

    it("a boot report keeps `retrying` and `drift`, and drops what no schema states", () => {
        const drift = [{ key: "connect", missing: ["CONNECT_TOKEN"], enables: "the platform", lost: "nothing", repair: "run setup again" }];
        expect(BootReportBodySchema.parse({ reach: "unreachable", retrying: false, drift, at: "client-side", secret: "x" })).toEqual({
            reach: "unreachable",
            retrying: false,
            drift,
        });
    });

    it("an adoption from a daemon that remembers no name, logo or version", () => {
        const body = { ticket: "t", grant: "g", daemonUrl: "https://abc123def456.intentic.dev", owner: "o@example.com" };
        expect(AdoptionBodySchema.parse(body)).toEqual(body);
    });

    it("a setup report with no `failed`, and a claim form naming only its code", () => {
        expect(SetupReportBodySchema.parse({ code: "c", stage: "pulling-image" })).toEqual({ code: "c", stage: "pulling-image", failed: [] });
        expect(SetupClaimFormSchema.parse({ code: "c" })).toEqual({ code: "c" });
    });

    it("a farewell naming nobody, or something that is not a name", () => {
        expect(FarewellBodySchema.parse({})).toEqual({});
        expect(FarewellBodySchema.parse({ removedBy: 42 })).toEqual({});
        expect(FarewellBodySchema.parse({ removedBy: `  ic on rog ${"x".repeat(200)}` })).toEqual({ removedBy: `ic on rog ${"x".repeat(110)}` });
    });

    it("an empty local-dns body asks for the record to be withdrawn", () => {
        expect(LocalDnsBodySchema.parse({})).toEqual({});
    });

    it("a provision with no definition", () => {
        expect(FleetProvisionBodySchema.parse({ name: "  scratch " })).toEqual({ name: "scratch" });
    });
});

describe("ingressRefusalOf", () => {
    it("reads today's JSON refusal, a JSON message, and an older platform's text", () => {
        expect(ingressRefusalOf(`{"error":"unknown sandbox"}`)).toBe("unknown sandbox");
        expect(ingressRefusalOf(`{"message":"the upstream lane mirrors reads only"}`)).toBe("the upstream lane mirrors reads only");
        expect(ingressRefusalOf("error: this sandbox was deleted")).toBe("this sandbox was deleted");
        expect(ingressRefusalOf("<html>502 Bad Gateway</html>")).toBe("<html>502 Bad Gateway</html>");
    });

    it("has nothing to say for an empty body or an empty error", () => {
        expect(ingressRefusalOf("  ")).toBeUndefined();
        expect(ingressRefusalOf(`{"error":""}`)).toBeUndefined();
    });
});

describe("the route table", () => {
    it("names each method and path once", () => {
        const keys = Object.values(PLATFORM_INGRESS).map((route) => `${route.method} ${route.path}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it("serves the trial's model API under the base its client is pointed at", () => {
        expect([PLATFORM_INGRESS.trialModels.path, PLATFORM_INGRESS.trialChat.path]).toEqual([
            `${TRIAL_MODEL_API_PATH}/models`,
            `${TRIAL_MODEL_API_PATH}/chat/completions`,
        ]);
    });

    it("fills a path's parameters, each as one segment", () => {
        expect(ingressPath("reachability", { sandboxId: "abc123def456" })).toBe("/api/reachability/abc123def456");
        expect(ingressPath("hostedBuildReport", { buildId: "a/b" })).toBe("/sandbox/hosted-build-report/a%2Fb");
        expect(() => ingressPath("reachability")).toThrow("reachability: no value for {sandboxId}");
    });
});

// The callers that cannot import this module spell its values themselves: `ic` and the edge in Rust, the site's
// cleanup script in shell. Each spelling is read here, so the contract and they cannot drift apart unnoticed.
describe("callers in other languages spell the contract's values", () => {
    const source = (path: string): string => readFileSync(join(repoRoot(import.meta.url), path), "utf8");

    it("`ic` sends the connect token in the contract's header", () => {
        for (const path of ["_sandbox/ic/src/platform.rs", "_sandbox/ic/src/machine/enroll.rs"]) {
            expect([...source(path).matchAll(/\.header\("(x-intentic-[a-z-]+)"/gu)].map((match) => match[1])).toContain(CONNECT_TOKEN_HEADER);
        }
        expect(source("_site/site/public/scripts/cleanup.sh")).toContain(`-H "${CONNECT_TOKEN_HEADER}: $tok"`);
    });

    it("`ic` calls the contract's paths", () => {
        const platform = source("_sandbox/ic/src/platform.rs");
        expect(platform).toContain(`{platform_url}${PLATFORM_INGRESS.setupClaim.path}"`);
        expect(platform).toContain(`{}${PLATFORM_INGRESS.setupReport.path}"`);
        expect(platform).toContain(`{from_host}${PLATFORM_INGRESS.farewell.path}"`);
        const report = source("_sandbox/ic/src/sandbox/fix/report.rs");
        expect(report).toContain(`{platform_url}${PLATFORM_INGRESS.hostReportClaim.path}"`);
        expect(report).toContain(`{}${PLATFORM_INGRESS.hostReport.path}"`);
    });

    it("the edge asks the contract's paths", () => {
        expect(source("_platform/ingress/src/certificate.rs")).toContain(`pub const CERTIFICATE_PATH: &str = "${PLATFORM_INGRESS.edgeCertificate.path}";`);
        expect(source("_platform/ingress/src/revocation.rs")).toContain(
            `const REACHABILITY_PATH: &str = "${PLATFORM_INGRESS.reachability.path.replace("{sandboxId}", "")}";`,
        );
    });
});
