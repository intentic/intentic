import { SANDBOX_ID, TrialStatusSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

/* THE SHAPES MACHINES SEND THE PLATFORM AND WHAT IT ANSWERS, declared once for both ends (routes.ts names the route
 * each rides). Machines of every release talk to the platform of every release (COMPATIBILITY.md), so a field the
 * platform adds to a request is optional, and an answer field a caller reads is optional on the caller's side too. */

// Accept only a valid https origin, so a bogus value can't be stored as a sandbox's address.
export const isHttpsUrl = (value: string): boolean => URL.canParse(value) && new URL(value).protocol === "https:";
const HttpsUrlSchema = z.string().refine(isHttpsUrl, "daemonUrl must be an https URL");

// An optional label a machine says about itself (its name, its side, its run id, its version): trimmed, held to `max`,
// and read as absent when it is not one. A call is never refused for a label: an older or odder caller's word is
// dropped, not fatal.
const label = (max: number) => z.string().trim().min(1).max(max).optional().catch(undefined);

// One broken check from a setup run: its name, what it found, and the fix, rendered verbatim in the wizard.
// `remedy` may be empty when the failure message already carries its own fix.
export const SetupReportFailureSchema = z.object({
    check: z.string().max(120),
    problem: z.string().max(2000),
    remedy: z.string().max(2000),
});
// Machine-side setup progress, POSTed on every stage transition, authenticated by the live setup code.
// Stages are the connect flow's real phases; non-empty `failed` is a verdict, `at` stamped by the platform.
export const SetupReportSchema = z.object({
    stage: z.enum(["preflight", "pulling-image", "creating-tunnel", "starting-sandbox", "starting-connector", "waiting-health", "verifying", "done"]),
    failed: z.array(SetupReportFailureSchema).max(12),
    at: z.string(),
});
export type SetupReport = z.infer<typeof SetupReportSchema>;

// The daemon's boot account as the platform keeps it (POSTed to /sandbox/boot-report, `at` stamped on receipt); an announce means the daemon started, not that it's
// reachable.
//   checking the probe has not concluded yet
//   reachable its own public address answered
//   unreachable it did not; `detail` says how
export const BootReportSchema = z.object({
    reach: z.enum(["checking", "reachable", "unreachable"]),
    // Why, for `unreachable`, already in the user's terms; rendered verbatim like a setup failure's problem.
    detail: z.string().max(2000).optional(),
    // False means the probe has stopped for good; absent means an older daemon never sent this field.
    retrying: z.boolean().optional(),
    // Boot-chain progress; `ready` is the readiness gate, `step` names what's running, absent on an older daemon.
    boot: z
        .object({
            ready: z.boolean(),
            step: z.string().max(200).optional(),
            done: z.number().int().nonnegative(),
            total: z.number().int().nonnegative(),
        })
        .optional(),
    // How much of the machine's time the host reclaimed, to tell a slow boot from the host's own quota.
    cpu: z.object({ throttledMs: z.number().nonnegative(), throttledPeriods: z.number().int().nonnegative() }).optional(),
    // Settled, unlike `reach`: a gap here is missing env, and only a setup run closes it.
    // Absent (older daemon) and empty (nothing missing) are read the same by clients.
    drift: z
        .array(
            z.object({
                key: z.string().max(64),
                missing: z.array(z.string().max(64)).max(12),
                enables: z.string().max(300),
                lost: z.string().max(2000),
                repair: z.string().max(500),
            }),
        )
        .max(12)
        .optional(),
    at: z.string(),
});
export type BootReport = z.infer<typeof BootReportSchema>;

/* WHAT A DAEMON'S ANNOUNCE CARRIES (POST /sandbox/announce, the connect token in `x-intentic-connect`): the address it
 * answers on, its version, and, from a daemon new enough (2026-10-05), which copy of the sandbox it is. `instance` is
 * minted once per container start (the front's INTENTIC_INSTANCE, else once per daemon process), `host` is the
 * machine's own name (HOST_LABEL) and `os` the side it runs on (HOST_ENV, else HOST_PLATFORM). Two instances that keep
 * announcing side by side are two containers holding one token, which the owner's summary names (`duplicateCopies`).
 * Every field past `daemonUrl` is a label (`label` above): an older daemon sends none of them, and the platform reads
 * that, or one it cannot read, as nothing known, never as a refusal. The daemon sends the same body every hour once registered, as its heartbeat. */
export const AnnounceBodySchema = z.object({
    daemonUrl: HttpsUrlSchema,
    version: label(64),
    instance: label(80),
    host: label(120),
    os: label(40),
});
export type AnnounceBody = z.input<typeof AnnounceBodySchema>;

/* WHAT THE MACHINE A SANDBOX RUNS ON FOUND, for the moments the browser cannot ask the sandbox itself. `ic sandbox fix`
 * writes it: run by the machine agent on its own when a sandbox of its machine stops answering (`agent`), by the command
 * the recovery panel hands out (`command`), or by the desktop app (`app`). The platform keeps only the latest one per
 * sandbox, and only for a sandbox on someone's own machine: a hosted one has `hostedStatus`. */

// The links of the chain `ic` checks, in the order it checks them. Strings on the wire, so a check a later `ic` adds
// never fails an older editor's parse; the editor has words of its own for these and prints `label` for any other.
export const HOST_CHECKS = [
    "prerequisites",
    "docker-app",
    "docker",
    "wsl",
    "disk",
    "container",
    "daemon",
    "registration",
    "network",
    "tunnel",
    "agent",
] as const;
export type HostCheckId = (typeof HOST_CHECKS)[number];

export const HostCheckSchema = z.object({
    id: z.string().max(40),
    // The check's name as `ic` prints it.
    label: z.string().max(120),
    state: z.enum(["ok", "warn", "fail", "fixing", "skip"]),
    // On warn/fail only: what is wrong and what closes it, already in the user's terms and rendered verbatim, like a
    // setup failure's.
    problem: z.string().max(2000).optional(),
    remedy: z.string().max(2000).optional(),
    // Who can close it. `auto`: `ic` does, now or on its next pass. `consent`: `ic` can once someone says yes, which the
    // handed-out command asks in its terminal. `you`: only a person can (a firmware switch, a dialog in Docker Desktop,
    // disk space only they can free).
    fix: z.enum(["auto", "consent", "you"]).optional(),
});
export type HostCheck = z.infer<typeof HostCheckSchema>;

// What `ic` sends; the platform stamps `at` on receipt.
export const HostReportInputSchema = z.object({
    source: z.enum(["agent", "command", "app"]),
    // The machine's own name, as the sandbox's device card calls it (`HOST_LABEL`), and the OS `ic` ran on there.
    machine: z.string().max(120),
    os: z.enum(["windows", "linux", "macos", "wsl"]),
    // checking → fixing → asking (a command waits on a yes in its terminal) → done.
    stage: z.enum(["checking", "fixing", "asking", "done"]),
    // While fixing, what it is doing ("Starting Docker Desktop"); while asking, the question it is waiting on.
    doing: z.string().max(300).optional(),
    // On `done` only. healthy: nothing on this machine was wrong. fixed: something was and is not now. needs-you: a
    // `you` check, or a `consent` one nobody agreed to, is left. failed: a fix was tried and did not take.
    outcome: z.enum(["healthy", "fixed", "needs-you", "failed"]).optional(),
    checks: z.array(HostCheckSchema).max(24),
    // (2026-10-05) Which environment on the machine ran it, when one machine has several (a WSL distro's name beside
    // `windows`). With `machine` and `os` it names the reporter: the platform keeps the newest report of each, so a
    // Windows agent and a WSL agent no longer overwrite each other. Absent from an older `ic`.
    env: z.string().max(80).optional(),
    // (2026-10-05) What the machine's own upkeep found, fixed and left last time it ran: leftovers of deleted sandboxes,
    // retired agent generations and the like, counted by kind. Absent from an `ic` that has no upkeep pass.
    upkeep: z
        .object({
            found: z.number().int().nonnegative(),
            fixed: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
            kinds: z.record(z.string().max(40), z.number().int().nonnegative()).optional(),
            // The machine agent that ran the pass, so the platform can tell which release left machines unconverged.
            agentVersion: z.string().max(40).optional(),
        })
        .optional(),
});
export type HostReportInput = z.infer<typeof HostReportInputSchema>;

export const HostReportSchema = HostReportInputSchema.extend({ at: z.string() });
export type HostReport = z.infer<typeof HostReportSchema>;

// `POST /host-report`, bearer the sandbox's report key: `sandbox` is its tunnel id, the hex its hostname carries.
export const HostReportPostSchema = z.object({ sandbox: z.string().regex(SANDBOX_ID), report: HostReportInputSchema });
export type HostReportPost = z.infer<typeof HostReportPostSchema>;

// `POST /host-report/claim`: a live fix code buys the sandbox it was minted for and that sandbox's report key, which
// `ic` keeps in its channel record so later runs (the machine agent's among them) can report with no code at all.
export const HostReportClaimSchema = z.object({ code: z.string().min(1).max(64) });
export const HostReportClaimedSchema = z.object({ sandbox: z.string(), key: z.string() });
export type HostReportClaimed = z.infer<typeof HostReportClaimedSchema>;

// The report key is HMAC-SHA256 over this label, keyed with the sandbox's connect token, in lowercase hex: `ic` derives
// it wherever it can read the container's env, the platform wherever it can decrypt the token, and it grants nothing
// but the one write above.
export const HOST_REPORT_KEY_LABEL = "intentic/host-report/v1";

// Which database the platform is reading (GET /api/identity): random per database, so a different one means the
// registry is not the one a browser or a daemon last spoke to, however healthy it looks.
export const PlatformIdentitySchema = z.object({
    identity: z.string(),
    // ISO, when this database was given its identity.
    since: z.string(),
});
export type PlatformIdentityAnswer = z.infer<typeof PlatformIdentitySchema>;

// What a machine redeeming a setup code may say about itself (POST /setup/claim, form fields beside `code`), from an
// `ic` new enough (2026-10-05): its name (HOST_LABEL's value), the side it runs on, and its own run id. The first claim
// that names a machine is kept, and a second one naming a DIFFERENT machine is refused while the code lives: one pasted
// command must not start two copies of the same sandbox. A claim that names nothing is never refused for it.
export const SetupClaimerSchema = z.object({
    host: z.string().max(120).optional(),
    os: z.string().max(40).optional(),
    instance: z.string().max(80).optional(),
});
export type SetupClaimer = z.infer<typeof SetupClaimerSchema>;

// `POST /setup/report` as `ic` sends it: the live setup code beside the report, whose `at` the platform stamps.
// `failed` defaults to none, for a report from before it was sent on every stage.
export const SetupReportBodySchema = z.object({
    code: z.string().min(1),
    stage: SetupReportSchema.shape.stage,
    failed: SetupReportSchema.shape.failed.default([]),
});

// `POST /setup/claim`'s form (application/x-www-form-urlencoded, the connect script's `curl -d code=…` and `ic`): the
// code, and what a machine new enough says about itself (SetupClaimerSchema), each a label. Answered with plain
// `KEY=value` lines, the env file the container starts with.
export const SetupClaimFormSchema = z.object({
    code: z.string().min(1),
    host: label(120),
    os: label(40),
    instance: label(80),
});

// `POST /sandbox/boot-report` as the daemon sends it: the report without the `at` the platform stamps. Every field
// past `reach` is optional, absent from an older daemon.
export const BootReportBodySchema = BootReportSchema.omit({ at: true });
export type BootReportBody = z.input<typeof BootReportBodySchema>;

// What a route that only takes something answers once it has.
export const IngressOkSchema = z.object({ ok: z.literal(true) });

// An announce the platform took: which database took it, from a platform new enough to say (GET /api/identity).
export const AnnounceAcceptedSchema = z.object({ ok: z.literal(true), identity: z.string().min(1).optional() });

// `POST /sandbox/adopt`: the owner's adoption ticket the browser handed the daemon, the grant this platform signed for
// the token, the address the token derives and the owner the daemon bound, with what the owner's browser remembers of
// the sandbox's name and logo. The version is a label: a daemon naming none, or a malformed one, is still adopted.
export const AdoptionBodySchema = z.object({
    ticket: z.string().min(1),
    grant: z.string().min(1),
    daemonUrl: HttpsUrlSchema,
    owner: z.string().optional(),
    name: z.string().optional(),
    image: z.string().optional(),
    version: label(64),
});
export const AdoptedSchema = z.object({ ok: z.literal(true), sandboxId: z.string(), identity: z.string().min(1).optional() });

// `POST /sandbox/farewell` (`ic`, and the site's cleanup script): who removed the container, cut to a line.
export const FarewellBodySchema = z.object({
    removedBy: z
        .string()
        .transform((said) => said.trim().slice(0, 120))
        .optional()
        .catch(undefined),
});

// The owner's name for the sandbox and its switcher logo, which only the platform holds (an export bundle asks).
export const PresentationSchema = z.object({ name: z.string(), image: z.string().optional() });

// The loopback certificate's DNS-01 relay: `challenge` published as the sandbox's record, or withdrawn when absent.
export const LocalDnsBodySchema = z.object({ challenge: z.string().max(128).optional() });
export const LocalDnsAnswerSchema = z.object({ ok: z.literal(true), hostname: z.string() });
// Cloudflare's own word on whether the record holds `challenge`.
export const LocalDnsConfirmBodySchema = z.object({ challenge: z.string().max(128) });
export const LocalDnsConfirmedSchema = z.object({ confirmed: z.boolean() });

// Whether a sandbox may hold a tunnel, for the edge (GET /api/reachability/{sandboxId}); a 404 is a deletion record and
// only that. `known: false` is an id the registry has no record of. `lane` stays for an edge build from before replay
// went, which replays a sandbox not named `tunnel`.
export const ReachabilitySchema = z.object({ ok: z.literal(true), lane: z.enum(["tunnel", "hosted"]), known: z.literal(false).optional() });

// The edge's TLS certificate and key, to an edge presenting the platform token.
export const EdgeCertificateSchema = z.object({ certificate: z.string(), privateKey: z.string() });

// The free trial's allowance for the sandbox's owner today; the daemon adds whether the trial is on.
export const TrialAllowanceSchema = TrialStatusSchema.omit({ available: true });

/* The x402 wallet's signer. */

// Dollars to no more places than USDC's six decimals, so no amount a caller states is cut on its way to atomic units.
const UsdSchema = z.string().regex(/^\d+(\.\d{1,6})?$/);
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export const WalletEnsureBodySchema = z.object({ network: z.string() });
export const WalletAddressSchema = z.object({ address: z.string() });
// One EIP-3009 transferWithAuthorization to sign: the EIP-712 domain off the challenge, so the platform signs what the
// facilitator will check, and the amount and host for the platform's own ledger row.
export const WalletSignBodySchema = z.object({
    network: z.string(),
    asset: z.string(),
    domainName: z.string().min(1),
    domainVersion: z.string().min(1),
    amountUsd: UsdSchema,
    host: z.string().min(1),
    authorization: z.object({
        from: z.string().regex(HEX_ADDRESS),
        to: z.string().regex(HEX_ADDRESS),
        value: z.string().regex(/^\d+$/),
        validAfter: z.string().regex(/^\d+$/),
        validBefore: z.string().regex(/^\d+$/),
        nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    }),
});
export type WalletSignBody = z.input<typeof WalletSignBodySchema>;
export const WalletSignatureSchema = z.object({ signature: z.string() });

/* The provisioning door, under an account's API token. */

// A sandbox.toml is a document a person wrote, and this is the ceiling where one stops being that. It rides into the
// container as an env value, so an unbounded one would be refused later, further from whoever sent it.
export const FLEET_DEFINITION_MAX_BYTES = 64 * 1024;

export const FleetWhoSchema = z.object({ email: z.string(), label: z.string() });
export const FleetSandboxesSchema = z.object({
    sandboxes: z.array(
        z.object({
            id: z.string(),
            name: z.string(),
            url: z.string().optional(),
            // Absent until the daemon in it first announces; a box created but never come up has none.
            lastSeenAt: z.string().optional(),
        }),
    ),
});
// One sandbox's row, named as the switcher shows it (the browser's own form holds the same bound), seeded from a
// sandbox.toml when one is sent.
export const FleetProvisionBodySchema = z.object({
    name: z.string().trim().min(1).max(60),
    definition: z.string().max(FLEET_DEFINITION_MAX_BYTES).optional(),
});
export const FleetProvisionedSchema = z.object({
    sandboxId: z.string(),
    name: z.string(),
    hostname: z.string(),
    setupCode: z.string(),
    expiresAt: z.string(),
});

// What every ingress route says when it refuses, whatever the status (routes.ts has the exceptions a third party's
// format decides). A platform from before it answered most refusals as plain `error: …` text; `ingressRefusalOf`
// reads both.
export const IngressErrorSchema = z.object({ error: z.string() });
export type IngressError = z.infer<typeof IngressErrorSchema>;

// The sentence a refusal carries, however its platform spelled it: `{ "error": … }`, a JSON `message`, or an older
// platform's `error: …` text. Undefined for a body with nothing to say.
export const ingressRefusalOf = (body: string): string | undefined => {
    const raw = body.trim();
    if (raw === "") {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(raw);
        const said = z.object({ error: z.string() }).or(z.object({ message: z.string() })).safeParse(parsed);
        if (said.success) {
            const text = ("error" in said.data ? said.data.error : said.data.message).trim();
            return text === "" ? undefined : text;
        }
    } catch {
        // allow(silent-catch): a body that is not JSON is an older platform's text, read below.
    }
    const text = raw.replace(/^error:\s*/u, "").trim();
    return text === "" ? undefined : text;
};
