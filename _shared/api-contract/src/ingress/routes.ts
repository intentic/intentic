import type { z } from "zod";
import {
    AdoptedSchema,
    AdoptionBodySchema,
    AnnounceAcceptedSchema,
    AnnounceBodySchema,
    BootReportBodySchema,
    EdgeCertificateSchema,
    FarewellBodySchema,
    FleetProvisionBodySchema,
    FleetProvisionedSchema,
    FleetSandboxesSchema,
    FleetWhoSchema,
    HostReportClaimedSchema,
    HostReportClaimSchema,
    HostReportPostSchema,
    HostWakesAnswerSchema,
    HostWakesAskSchema,
    IngressOkSchema,
    LocalDnsAnswerSchema,
    LocalDnsBodySchema,
    LocalDnsConfirmBodySchema,
    LocalDnsConfirmedSchema,
    PlatformIdentitySchema,
    PresentationSchema,
    ReachabilitySchema,
    SetupClaimFormSchema,
    SetupReportBodySchema,
    TrialAllowanceSchema,
    WalletAddressSchema,
    WalletEnsureBodySchema,
    WalletSignatureSchema,
    WalletSignBodySchema,
} from "./ingress-schemas.js";

/* EVERY ROUTE A MACHINE CALLS ON THE PLATFORM, outside the editor's oRPC contract under /rpc: the sandbox daemon, `ic`
 * on the owner's machine, the edge, a hosted image's builder and the trial's model translator. The platform registers
 * each under its entry here (`_platform/api/src/ingress.ts`) and the daemon calls each through it
 * (`_sandbox/sandbox/src/system/platform-client.ts`), so a path, a method or a body has one spelling.
 *
 * A route table rather than oRPC procedures: these routes predate the contract and are called by machines of every
 * release, so their paths sit at the root rather than under /rpc, most authenticate by a header oRPC's context would
 * have to carry, one takes a form and answers plain text, two stream bytes through untouched, and every refusal is
 * `{ "error": … }` (IngressErrorSchema) with the route's own status, which an older daemon and `ic` read today, where
 * oRPC's error body is its own. (2026-10-05)
 *
 * `{param}` is one path segment (ingressPath fills it). `auth` says what proves the caller:
 *   connect         the sandbox's connect token in CONNECT_TOKEN_HEADER
 *   connect-bearer  the connect token as a bearer, or in CONNECT_TOKEN_HEADER (an OpenAI-shaped client sends a bearer)
 *   provisioning    an account's API token with the `provision` scope, as a bearer
 *   report-key      the sandbox's host-report key as a bearer (HOST_REPORT_KEY_LABEL)
 *   platform-token  the edge's platform token, as a bearer
 *   build-secret    the build's own secret, in a header of the build report (the platform's hosted-build-script.ts)
 *   code            a live setup code or fix code in the body
 *   none            nobody: existence is not a secret
 * `body` is how the request is encoded and `answer` how a success is: `passthrough` is an upstream's bytes, relayed. */

export type IngressAuth = "connect" | "connect-bearer" | "provisioning" | "report-key" | "platform-token" | "build-secret" | "code" | "none";

export interface IngressRouteSpec {
    readonly method: "GET" | "POST";
    readonly path: `/${string}`;
    readonly auth: IngressAuth;
    readonly body: "json" | "form" | "raw" | "none";
    readonly answer: "json" | "text" | "empty" | "passthrough";
    readonly input?: z.ZodType;
    readonly output?: z.ZodType;
}

export const PLATFORM_INGRESS = {
    /* Setting a sandbox up, from the owner's machine (`ic`, the connect script's curl). */
    // The setup code redeemed for the container's env file; 404 for unknown and expired alike, 409 once another machine
    // claimed it.
    setupClaim: { method: "POST", path: "/setup/claim", auth: "code", body: "form", answer: "text", input: SetupClaimFormSchema },
    // Each stage of the setup run, for the wizard; answered `ok`.
    setupReport: { method: "POST", path: "/setup/report", auth: "code", body: "json", answer: "text", input: SetupReportBodySchema },
    // A fix code the recovery panel handed out, redeemed for the sandbox's tunnel id and report key (`ic sandbox fix`).
    hostReportClaim: {
        method: "POST",
        path: "/host-report/claim",
        auth: "code",
        body: "json",
        answer: "json",
        input: HostReportClaimSchema,
        output: HostReportClaimedSchema,
    },
    // What `ic sandbox fix` found on the machine; 204 whether stored or throttled, so `ic` never retries.
    hostReport: { method: "POST", path: "/host-report", auth: "report-key", body: "json", answer: "empty", input: HostReportPostSchema },
    // Which of the machine's sleeping sandboxes somebody wants back (`ic sandbox wakes`); each ask carries its own report
    // key in the body, so the route itself takes no credential.
    hostWakes: {
        method: "POST",
        path: "/host-report/wakes",
        auth: "none",
        body: "json",
        answer: "json",
        input: HostWakesAskSchema,
        output: HostWakesAnswerSchema,
    },
    // The container is gone (`ic`, the site's cleanup script).
    farewell: {
        method: "POST",
        path: "/sandbox/farewell",
        auth: "connect",
        body: "json",
        answer: "json",
        input: FarewellBodySchema,
        output: IngressOkSchema,
    },

    /* The daemon, as itself. */
    // Its address and which copy it is, at boot and hourly after; 404 is a registry that forgot it, 410 a deletion.
    announce: {
        method: "POST",
        path: "/sandbox/announce",
        auth: "connect",
        body: "json",
        answer: "json",
        input: AnnounceBodySchema,
        output: AnnounceAcceptedSchema,
    },
    // A row made again for a sandbox the registry has no record of, on its owner's ticket.
    adopt: { method: "POST", path: "/sandbox/adopt", auth: "connect", body: "json", answer: "json", input: AdoptionBodySchema, output: AdoptedSchema },
    // Whether its public address answers, its boot progress and its missing environment.
    bootReport: {
        method: "POST",
        path: "/sandbox/boot-report",
        auth: "connect",
        body: "json",
        answer: "json",
        input: BootReportBodySchema,
        output: IngressOkSchema,
    },
    // Its owner's name for it and its logo, for an export bundle.
    presentation: { method: "POST", path: "/sandbox/presentation", auth: "connect", body: "json", answer: "json", output: PresentationSchema },
    // The loopback certificate's DNS-01 record, and Cloudflare's word that it holds.
    localDns: {
        method: "POST",
        path: "/sandbox/local-dns",
        auth: "connect",
        body: "json",
        answer: "json",
        input: LocalDnsBodySchema,
        output: LocalDnsAnswerSchema,
    },
    localDnsConfirm: {
        method: "POST",
        path: "/sandbox/local-dns/confirm",
        auth: "connect",
        body: "json",
        answer: "json",
        input: LocalDnsConfirmBodySchema,
        output: LocalDnsConfirmedSchema,
    },
    // The free trial: today's allowance, and the OpenAI-shaped model API the daemon's translator calls, whose bodies
    // and refusals are OpenAI's (`{ error: { type, message } }`), relayed rather than declared.
    trialStatus: { method: "GET", path: "/trial/status", auth: "connect-bearer", body: "none", answer: "json", output: TrialAllowanceSchema },
    trialModels: { method: "GET", path: "/trial/v1/models", auth: "connect-bearer", body: "none", answer: "passthrough" },
    trialChat: { method: "POST", path: "/trial/v1/chat/completions", auth: "connect-bearer", body: "raw", answer: "passthrough" },
    // The x402 wallet: the owner's address on a network, and one signature under the owner's caps.
    walletEnsure: {
        method: "POST",
        path: "/wallet/ensure",
        auth: "connect",
        body: "json",
        answer: "json",
        input: WalletEnsureBodySchema,
        output: WalletAddressSchema,
    },
    walletSign: {
        method: "POST",
        path: "/wallet/sign",
        auth: "connect",
        body: "json",
        answer: "json",
        input: WalletSignBodySchema,
        output: WalletSignatureSchema,
    },

    /* The daemon, for its owner's account (the `sandboxes` CLI, under the `fleet` capability's token). */
    fleetWhoami: { method: "GET", path: "/fleet/whoami", auth: "provisioning", body: "none", answer: "json", output: FleetWhoSchema },
    fleetSandboxes: { method: "GET", path: "/fleet/sandboxes", auth: "provisioning", body: "none", answer: "json", output: FleetSandboxesSchema },
    fleetProvision: {
        method: "POST",
        path: "/fleet/provision",
        auth: "provisioning",
        body: "json",
        answer: "json",
        input: FleetProvisionBodySchema,
        output: FleetProvisionedSchema,
    },

    /* The edge, a hosted image's builder, and anyone asking which database this is. */
    reachability: { method: "GET", path: "/api/reachability/{sandboxId}", auth: "none", body: "none", answer: "json", output: ReachabilitySchema },
    edgeCertificate: { method: "GET", path: "/api/ingress/certificate", auth: "platform-token", body: "none", answer: "json", output: EdgeCertificateSchema },
    // A build's exit code and digest in headers, its log tail as the raw body.
    hostedBuildReport: {
        method: "POST",
        path: "/sandbox/hosted-build-report/{buildId}",
        auth: "build-secret",
        body: "raw",
        answer: "json",
        output: IngressOkSchema,
    },
    identity: { method: "GET", path: "/api/identity", auth: "none", body: "none", answer: "json", output: PlatformIdentitySchema },
} as const satisfies Record<string, IngressRouteSpec>;

// The base an OpenAI-shaped client is pointed at for the trial (the daemon's translator): `trialModels` and
// `trialChat` are its `/models` and `/chat/completions`.
export const TRIAL_MODEL_API_PATH = "/trial/v1";

export type IngressRouteName = keyof typeof PLATFORM_INGRESS;
type RouteOf<K extends IngressRouteName> = (typeof PLATFORM_INGRESS)[K];

// What a caller sends a route, and what the platform reads it as once its schema has parsed it.
export type IngressInput<K extends IngressRouteName> = RouteOf<K> extends { readonly input: infer S extends z.ZodType } ? z.input<S> : never;
export type IngressBody<K extends IngressRouteName> = RouteOf<K> extends { readonly input: infer S extends z.ZodType } ? z.output<S> : never;
// What a route answers on success.
export type IngressOutput<K extends IngressRouteName> = RouteOf<K> extends { readonly output: infer S extends z.ZodType } ? z.output<S> : never;

// A route's path with its `{param}` segments filled, each encoded as one segment.
export const ingressPath = (name: IngressRouteName, params: Readonly<Record<string, string>> = {}): string =>
    PLATFORM_INGRESS[name].path.replace(/\{([^}]+)\}/gu, (_, key: string) => {
        const value = params[key];
        if (value === undefined) {
            throw new Error(`${name}: no value for {${key}}`);
        }
        return encodeURIComponent(value);
    });
