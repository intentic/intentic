import { z } from "zod";
// version is this build's baked-in version; latest/updateAvailable come from comparing it to the published stable
// release.
// Whether a runtime can serve a turn, probed off the turn path. "unknown" reads as available-but-unverified, never as
// unavailable.
export const AdapterHealthSchema = z.object({
    state: z
        .enum(["ready", "unavailable", "unknown"])
        .describe(
            "Whether this runtime can serve a turn. Unknown is a real answer rather than a soft no: a check that could not run must not grey out a provider you can in fact use.",
        ),
    // Why it cannot serve and what to do about it; absent when ready.
    detail: z.string().optional().describe("Why it cannot, and what to do about it. Absent when it can."),
    checkedAt: z.number().describe("When it was last checked, in milliseconds."),
});
export type AdapterHealthReport = z.infer<typeof AdapterHealthSchema>;
// An update already downloaded and built, waiting for the restart that applies it. Advisory only: the swap re-derives
// these facts and refuses the fast path if they drifted.
export const StagedUpdateSchema = z.object({
    // What the staged build reports about itself; absent means ready but unnamed, not that nothing is ready.
    version: z.string().optional().describe("What the downloaded build says it is. Absent means ready but unnamed, never that nothing is ready."),
    // Channel it was staged from; not necessarily the one this sandbox follows.
    channel: z
        .string()
        .describe(
            "Which channel it was taken from. Not necessarily the one this sandbox follows: downloading a beta build is not the same as moving onto beta.",
        ),
    // Epoch ms the download finished; used to check this is still the update being offered.
    at: z.number().describe("When the download finished, in milliseconds, which answers whether this is still the update being offered."),
    // The staged build's state pre-flight (the daemon's state-plan.ts, run by `ic sandbox prepare` over read-only mounts
    // of this sandbox's volumes): what its first boot converts, before anyone accepts the update.
    plan: z
        .object({
            ok: z.boolean().describe("False when a conversion would fail on this sandbox's files, which refuses the update before anything is touched."),
            downgrade: z.boolean().optional().describe("The staged build is older than the one that converted these files; it opens them read-only."),
            steps: z
                .array(z.object({ document: z.string(), change: z.string() }))
                .optional()
                .describe("Each stored file the first boot converts, and how."),
            failures: z
                .array(z.object({ document: z.string(), detail: z.string() }))
                .optional()
                .describe("Each conversion that would fail, and why."),
        })
        .optional()
        .describe("What the downloaded build's first boot would convert in this sandbox's stored files. Absent when no plan could be had, which says nothing either way."),
});
export type StagedUpdate = z.infer<typeof StagedUpdateSchema>;
export const InfoSchema = z.object({
    name: z.string().optional().describe("What this sandbox is called."),
    image: z.string().optional().describe("The image it is running."),
    version: z.string().optional().describe("The version of that image."),
    latest: z.string().optional().describe("The newest published version on its channel."),
    updateAvailable: z.boolean().optional().describe("Whether those two differ."),
    // Keyed by AgentCapabilities.runtime; absent until the first sweep, reading as every entry unknown.
    runtimes: z
        .record(z.string(), AdapterHealthSchema)
        .optional()
        .describe(
            "Which agent runtimes can serve a turn right now, keyed by runtime. Absent until the first check has run, which reads the same as every entry being unknown.",
        ),
    // Channel and previousImage are set by the host swap script; previousImage absent means no rollback.
    channel: z.string().optional().describe("Which release channel this sandbox follows."),
    previousImage: z
        .string()
        .optional()
        .describe("The image the last update replaced, which is what a rollback would return to. Absent means there is nothing to go back to."),
    // User-facing release notes from version to latest, newest first; absent or empty means nothing to say.
    updateNotes: z
        .array(z.string())
        .optional()
        .describe(
            "What is in the update, in the words of the people it is for, newest first. Absent or empty whenever there is nothing worth saying, which reads on screen exactly as it did before there were notes at all.",
        ),
    // How many further notes exist beyond the ones sent; absent or zero means updateNotes has them all.
    moreUpdateNotes: z
        .number()
        .optional()
        .describe(
            "How many further notes there are beyond the ones sent, for a sandbox left alone a long time. Absent or zero means you have all of them.",
        ),
    // Breaking-change lines from every release in the gap, uncapped; absent for updates that break nothing.
    breakingNotes: z
        .array(z.string())
        .optional()
        .describe(
            "What the update takes away, uncapped, because a warning that fell off a shortened list is a breaking update taken unwarned. Absent for the overwhelming majority, which break nothing.",
        ),
    // Update already downloaded and built, waiting for the restart that applies it; absent when nothing is staged.
    staged: StagedUpdateSchema.optional().describe(
        "An update already downloaded and built on the machine running this container, waiting only for the restart that applies it. That restart is seconds, where an unprepared update is minutes, which is a different decision entirely. Absent when nothing is waiting.",
    ),
});
export type Info = z.infer<typeof InfoSchema>;
// What the daemon could not read in its own `.intentic/` state files, and in the files on its volume that
// REPORTED_VOLUME_FILES names. Reported per file, only for files listed in REPORTED_MANIFEST_PATHS or
// REPORTED_VOLUME_FILES (workspace-state.ts). `kind`:
// unreadable: whole file ignored, everything in it at default.
// unknownKey: only that key ignored; `suggestion` may name what it should be.
// invalidEntry: one list entry skipped, rest of the file stands.
export const ManifestProblemSchema = z.object({
    kind: z
        .enum(["unreadable", "unknownKey", "invalidEntry"])
        .describe(
            "What to do about it. Unreadable means the whole file is being ignored and everything in it is at its default. An unknown key means only that key is ignored. An invalid entry means one item of a list was skipped and the rest is fine.",
        ),
    detail: z.string().describe("What exactly was wrong, as one sentence and nothing else. Never the remedy: that is `fix`."),
    suggestion: z.string().optional().describe("The name it was probably meant to be, when one is close enough to guess honestly."),
    // Set only when the fix isn't "open the file and correct it", e.g. a version skew where editing would be wrong.
    fix: z
        .string()
        .optional()
        .describe("What to do about it, when that is something other than 'correct the file'. Absent whenever the file itself is the thing to edit."),
});
export type ManifestProblem = z.infer<typeof ManifestProblemSchema>;
// Workspace-relative path and everything currently wrong with that file; a clean file is absent from the list, not
// present and empty.
export const ManifestProblemReportSchema = z.object({
    path: z
        .string()
        .describe(
            "The file, as a workspace path, or as its absolute path on the daemon's own history volume for one kept there (the conversation registry). The file is the unit somebody fixes, which is why problems are grouped by it.",
        ),
    problems: z
        .array(ManifestProblemSchema)
        .describe("Everything currently wrong with it. A file with nothing wrong is absent rather than present and empty."),
});
export type ManifestProblemReport = z.infer<typeof ManifestProblemReportSchema>;
export const ManifestProblemsSchema = z.array(ManifestProblemReportSchema);

// The one repair a button may perform: drop a stray top-level key, or rename it to what `suggestion` named. The other
// two problem kinds are refused:
// unreadable: nothing to act on but bytes; the file may already be correct (version skew).
// invalidEntry: dropping it would remove real configuration, not an inert key.
export const ManifestRepairSchema = z.object({
    path: z
        .string()
        .describe(
            "The file to repair, as the workspace path the problem was reported under. Only the handful of manifests a person hand-edits can be named; anything else is refused.",
        ),
    key: z.string().describe("The stray top-level key, exactly as it was reported. Absent from the file already means there is nothing to do."),
    to: z
        .string()
        .optional()
        .describe(
            "Rename the key to this instead of removing it, carrying its value across. Absent means remove it. Naming a key that is already in the file is refused rather than silently overwriting what is there.",
        ),
});
export type ManifestRepair = z.infer<typeof ManifestRepairSchema>;
// Steady-state browser credential (system.session), exchanged for a verified Google ID token so Google UI appears only
// at sign-in. expiresAt is epoch ms; renew ahead of it without parsing the token.
export const DaemonSessionSchema = z.object({
    token: z.string().describe("The credential every other call carries. Present it as a bearer token."),
    expiresAt: z.number().describe("When it stops working, in milliseconds, so a caller can renew ahead of it without reading the token."),
    email: z.string().describe("Who the sandbox verified you as."),
});
export type DaemonSession = z.infer<typeof DaemonSessionSchema>;

// Passkeys registered with one sandbox, and the owner's rule that a passkey is the only proof that opens it. The
// daemon is the WebAuthn relying party; these are the shapes its /system/passkeys routes and the 428 step-up carry.

// How a session's identity was proven. A session carries the set it was minted from; the require-passkey policy reads
// it on every request, so a session minted before the switch stops working on its next call.
export const ProofMethodSchema = z.enum(["google", "ticket", "passkey", "recovery"]);
export type ProofMethod = z.infer<typeof ProofMethodSchema>;

export const PasskeySummarySchema = z.object({
    id: z.string().describe("The credential id the authenticator chose, base64url."),
    email: z.string().describe("Whose passkey this is; the owner's list carries every member's, a member's only their own."),
    label: z.string().describe("The name given at registration, or the daemon's default."),
    rpId: z.string().describe("The editor host this passkey is bound to; a passkey answers only from that origin."),
    createdAt: z.number().describe("Epoch ms of registration."),
    lastUsedAt: z.number().optional().describe("Epoch ms of the last sign-in it answered; absent means never."),
    backedUp: z.boolean().describe("Whether the authenticator syncs this passkey (a phone's keychain) or holds the only copy (a hardware key)."),
});
export type PasskeySummary = z.infer<typeof PasskeySummarySchema>;

export const PasskeysListSchema = z.object({
    passkeys: z.array(PasskeySummarySchema),
    required: z.boolean().describe("Whether a passkey is the only proof that opens this sandbox; owner-set."),
    recovery: z
        .object({ remaining: z.number() })
        .optional()
        .describe("Owner only, while required: how many one-time recovery codes are still unspent."),
});
export type PasskeysList = z.infer<typeof PasskeysListSchema>;

export const PasskeyPolicySchema = z.object({ required: z.boolean() });
export type PasskeyPolicy = z.infer<typeof PasskeyPolicySchema>;

// Shown exactly once: the daemon keeps only their hashes.
export const RecoveryCodesSchema = z.object({ codes: z.array(z.string()) });
export type RecoveryCodes = z.infer<typeof RecoveryCodesSchema>;

export const PasskeyRecoverRequestSchema = z.object({ code: z.string().min(1) });

// The 428 body: the caller is who they say, but this sandbox requires a passkey and the proof presented has none.
// `enrolled` says whether they hold one to answer with, or must add their first before anything else is served.
export const PasskeyRequiredSchema = z.object({
    error: z.string(),
    requires: z.literal("passkey"),
    enrolled: z.boolean(),
});
export type PasskeyRequired = z.infer<typeof PasskeyRequiredSchema>;

// The two WebAuthn responses as the browser serialises them (`PublicKeyCredential.toJSON()`); every binary field is
// base64url. The daemon parses the body with these before any cryptography runs.
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+$/, "base64url");

export const RegistrationResponseSchema = z.object({
    id: Base64Url,
    rawId: Base64Url,
    type: z.literal("public-key"),
    response: z.object({
        clientDataJSON: Base64Url,
        attestationObject: Base64Url,
        transports: z.array(z.string()).optional(),
    }),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
});
export type RegistrationResponse = z.infer<typeof RegistrationResponseSchema>;

export const AuthenticationResponseSchema = z.object({
    id: Base64Url,
    rawId: Base64Url,
    type: z.literal("public-key"),
    response: z.object({
        clientDataJSON: Base64Url,
        authenticatorData: Base64Url,
        signature: Base64Url,
        userHandle: Base64Url.optional(),
    }),
    authenticatorAttachment: z.string().optional(),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional(),
});
export type AuthenticationResponse = z.infer<typeof AuthenticationResponseSchema>;

export const PasskeyRegisterRequestSchema = z.object({
    response: RegistrationResponseSchema,
    label: z.string().optional(),
});

export const PasskeyAssertRequestSchema = z.object({ response: AuthenticationResponseSchema });

// The options the daemon hands the browser, in the JSON form `PublicKeyCredential.parseCreationOptionsFromJSON` and
// `parseRequestOptionsFromJSON` take. Typed rather than parsed: only the daemon writes them.
export interface CredentialDescriptorJSON {
    readonly type: "public-key";
    readonly id: string;
    readonly transports?: readonly string[];
}

export interface RegistrationOptionsJSON {
    readonly rp: { readonly id: string; readonly name: string };
    readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
    readonly challenge: string;
    readonly pubKeyCredParams: readonly { readonly type: "public-key"; readonly alg: number }[];
    readonly timeout: number;
    readonly attestation: "none";
    readonly excludeCredentials: readonly CredentialDescriptorJSON[];
    readonly authenticatorSelection: { readonly residentKey: "required"; readonly requireResidentKey: true; readonly userVerification: "required" };
}

export interface AuthenticationOptionsJSON {
    readonly rpId: string;
    readonly challenge: string;
    readonly timeout: number;
    readonly userVerification: "required";
    readonly allowCredentials: readonly CredentialDescriptorJSON[];
    // Whether any passkey is registered for this origin at all, so a sign-in screen can offer the button only when
    // pressing it can succeed.
    readonly available: boolean;
}
