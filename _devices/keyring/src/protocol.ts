import { z } from "zod";
import {
    KEYRING_CAPTURE_BATCH_MAX,
    KEYRING_NONCE_RE,
    KEYRING_PROGRAMS_MAX,
    KeyringCaptureItemSchema,
    KeyringCaptureResultSchema,
    KeyringCaptureSourceSchema,
    KeyringCopiesSchema,
    KeyringInboxItemSchema,
    KeyringInboxResultSchema,
    KeyringNeedAnswerSchema,
    KeyringNeedResultSchema,
    KeyringNeedSchema,
    KeyringOriginSchema,
    KeyringPackageSchema,
    KeyringPendingNeedSchema,
    KeyringPhoneFillResultSchema,
    KeyringPhoneKeysSchema,
    KeyringPhonePairResultSchema,
    KeyringRememberSchema,
    KeyringProgramSchema,
    KeyringRefusalCodeSchema,
    KeyringReleaseResultSchema,
    KeyringSecretNameSchema,
    KeyringShareModeSchema,
    KeyringSourceSchema,
    KeyringStateSchema,
    KeyringSyncDeliverResultSchema,
    KeyringSyncDeliverSchema,
    KeyringSyncOutboxSchema,
    KeyringSyncPairResultSchema,
    KeyringSyncPairSchema,
    KeyringSyncStateSchema,
    KeyringTypeInputSchema,
    KeyringTypeResultSchema,
    KeyringPointerSchema,
    SealedBoxSchema,
    SignedKeyringGrantSchema,
    SignedKeyringPhoneFillSchema,
} from "@intentic/sandbox-contract/schemas/keyring";

// The keyring's local pipe: one JSON line in, one JSON line out, one request per connection. A named pipe on Windows,
// a unix socket in the keyring's own 0700 directory elsewhere (address.ts). Every caller is another process of the same
// user, so nothing here is trusted for WHO asks: a release or a typing needs a grant the sandbox signed, and anything
// that changes the vault, takes a value in, or hands one to a local program needs a person at this computer
// (consent.ts). What a caller learns without either is names and rules, never a value.

const sandboxUrl = z.string().url();
const hostPattern = z.string().min(1).max(253);

// A prompt-text matcher for askpass: `ssh:user@host`, `ssh-key:/path/to/key`, `sudo`, `sudo:user`,
// `git:https://host`, or `prompt:<text>` for a program that asks in words of its own (askpass.ts reads them).
export const AskpassMatcherSchema = z
    .string()
    .min(1)
    .max(300)
    .regex(/^(ssh|ssh-key|sudo|git|prompt)(:.+)?$/u)
    .describe("Which askpass prompt it answers: `ssh:user@host`, `ssh-key:/path`, `sudo`, `sudo:user`, `git:https://host`, or `prompt:<text>`.");

const entryRules = {
    kind: z.enum(["password", "text"]),
    programs: z.array(KeyringProgramSchema).max(KEYRING_PROGRAMS_MAX),
    packages: z.array(KeyringPackageSchema).max(KEYRING_PROGRAMS_MAX),
    hosts: z.array(hostPattern).max(KEYRING_PROGRAMS_MAX),
    anyField: z.boolean(),
    username: z.string().max(256).optional().describe("The user name that goes with it, for an askpass `Username for` prompt. Not a secret."),
    askpass: z.array(AskpassMatcherSchema).max(KEYRING_PROGRAMS_MAX),
    // Minutes an askpass answer is remembered for the same matcher without asking again. 0, the default, asks every time:
    // a remembered answer is one any program of this user can collect, the agent's own commands included.
    askpassRememberMinutes: z.number().int().min(0).max(240),
    note: z.string().max(500).optional(),
    title: z.string().max(200).optional().describe("What the Passwords app calls it, `github.com`. Made from where it was first seen; the person may rename it."),
};

// Where a backed entry's value is read from at each use, instead of the vault.
export const BackendRefSchema = z.discriminatedUnion("backend", [
    z.object({ backend: z.literal("1password"), ref: z.string().regex(/^op:\/\/.+/u).max(500).describe("A secret reference, `op://Vault/Item/field`.") }),
    z.object({ backend: z.literal("bitwarden"), ref: z.string().min(1).max(200).describe("The item's id or exact name."), field: z.enum(["password", "username", "totp", "notes"]).default("password") }),
    z.object({ backend: z.literal("keepassxc"), ref: z.string().min(1).max(500).describe("The entry's path in the database, `Group/Entry`."), attribute: z.string().min(1).max(100).default("Password") }),
]);
export type BackendRef = z.infer<typeof BackendRefSchema>;

export const ShareInfoSchema = z.object({
    sandbox: sandboxUrl,
    machine: z.string().describe("The device card this computer is known by in that sandbox."),
    mode: KeyringShareModeSchema,
    sharedAt: z.number(),
});
export type ShareInfo = z.infer<typeof ShareInfoSchema>;

// How an entry came to be, when it was seen rather than added by hand: the app's "saved from Brave" line.
export const CapturedInfoSchema = z.object({ source: KeyringCaptureSourceSchema, via: z.string(), at: z.number() });
export type CapturedInfo = z.infer<typeof CapturedInfoSchema>;

// The fields below `updatedAt` are absent from a keyring older than 2026-10-19, which the desktop app may be talking to.
export const EntryInfoSchema = z.object({
    name: KeyringSecretNameSchema,
    ...entryRules,
    source: KeyringSourceSchema,
    backend: BackendRefSchema.optional(),
    shares: z.array(ShareInfoSchema),
    createdAt: z.number(),
    updatedAt: z.number(),
    captured: CapturedInfoSchema.optional().describe("Where it was seen, for an entry a capture made or last changed."),
    fresh: z.boolean().optional().describe("Saved or changed by a capture and not yet looked at in the Passwords app."),
    unverified: z.boolean().optional().describe("Captured, and not yet seen to work: replaced rather than kept as history if the next capture says it failed."),
    lastUsedAt: z.number().optional().describe("When it was last typed, released or answered with."),
    versions: z.number().int().nonnegative().optional().describe("Earlier values kept in its history."),
    health: z
        .object({ weak: z.boolean(), reused: z.boolean() })
        .optional()
        .describe("Worked out inside the keyring while it is unlocked; never the value. Absent while locked."),
});
export type EntryInfo = z.infer<typeof EntryInfoSchema>;

export const EntryRulesSchema = z.object(entryRules);
export type EntryRules = z.infer<typeof EntryRulesSchema>;
export const EntryPatchSchema = EntryRulesSchema.partial().strict();
export type EntryPatch = z.infer<typeof EntryPatchSchema>;

// How the vault is set up for unlocking, chosen at `setup`: a passphrase always (recovery when Windows Hello is reset or
// the computer replaced), Windows Hello where the computer has it.
export const SetupSchema = z
    .object({
        op: z.literal("setup"),
        // The passphrase itself rides the request: setup runs before the vault has an inbox key to seal it to, and the
        // pipe is this user's alone. The caller reads it from a terminal without echo, or from the desktop app's form.
        passphrase: z.string().min(10).max(1024),
        hello: z.boolean().describe("Also unlock with Windows Hello. Ignored where Hello is not available."),
    })
    .strict();

export const BackendConfigSchema = z.discriminatedUnion("backend", [
    z.object({ backend: z.literal("1password"), cli: z.string().min(1).max(500).default("op"), account: z.string().max(200).optional(), tokenEntry: KeyringSecretNameSchema.optional().describe("An entry holding a service-account token, for unattended reads. Absent: the 1Password app's own unlock.") }),
    z.object({ backend: z.literal("bitwarden"), cli: z.string().min(1).max(500).default("bw"), passwordEntry: KeyringSecretNameSchema.describe("The entry holding the Bitwarden master password.") }),
    z.object({ backend: z.literal("keepassxc"), cli: z.string().min(1).max(500).default("keepassxc-cli"), database: z.string().min(1).max(1000), keyFile: z.string().max(1000).optional(), passwordEntry: KeyringSecretNameSchema }),
]);
export type BackendConfig = z.infer<typeof BackendConfigSchema>;

// The Passwords app's settings, kept sealed in the vault, `remember` also in its open part so a collector can ask
// whether to send without anyone unlocking.
export const KeyringSettingsSchema = z.object({
    remember: KeyringRememberSchema,
    rememberAskedAt: z.number().optional().describe("When the person answered the one-time 'remember the passwords you type'."),
    neverSave: z.array(KeyringOriginSchema).max(500).describe("Places never to save for, from a toast's 'Never for this site' or Settings."),
    autoLockMinutes: z.number().int().min(1).max(720),
    lockOnSleep: z.boolean(),
});
export type KeyringSettings = z.infer<typeof KeyringSettingsSchema>;
export const KeyringSettingsPatchSchema = KeyringSettingsSchema.omit({ rememberAskedAt: true }).partial().extend({ remember: KeyringRememberSchema.partial().optional() }).strict();
export type KeyringSettingsPatch = z.infer<typeof KeyringSettingsPatchSchema>;

// One line of the keyring's record, as the Passwords app shows it (audit.ts writes it): never a value.
export const ActivityItemSchema = z.object({
    at: z.number(),
    op: z.string().describe("What happened: `release`, `type`, `askpass`, `capture`, `fill`, `need`, `add`, `edit`, `remove`, `share`, …"),
    outcome: z.string().describe("`granted`, `done`, `refused`, `pending`, `saved`, `updated`, …"),
    secret: KeyringSecretNameSchema.optional(),
    sandbox: z.string().optional(),
    program: z.string().optional(),
    target: z.string().optional(),
    asked: z.boolean().optional(),
    code: z.string().optional(),
});
export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const KeyringRequestSchema = z.discriminatedUnion("op", [
    z.object({ op: z.literal("state") }).strict(),
    SetupSchema,
    z.object({ op: z.literal("unlock"), minutes: z.number().int().min(1).max(720).default(60) }).strict(),
    z.object({ op: z.literal("lock") }).strict(),
    // Local listing, for the CLI and the desktop app: names, rules and shares, never values.
    z.object({ op: z.literal("list") }).strict(),
    // A value taken in from this computer: sealed to the vault's inbox key, so even a squatter on the pipe holds only
    // ciphertext; taken in at once with a person's yes. A backed entry carries no value.
    z
        .object({
            op: z.literal("add"),
            name: KeyringSecretNameSchema,
            sealed: SealedBoxSchema.optional(),
            backend: BackendRefSchema.optional(),
            rules: EntryRulesSchema,
            replace: z.boolean().default(false),
        })
        .strict(),
    z.object({ op: z.literal("edit"), name: KeyringSecretNameSchema, patch: EntryPatchSchema, sealed: SealedBoxSchema.optional() }).strict(),
    z.object({ op: z.literal("remove"), name: KeyringSecretNameSchema }).strict(),
    z
        .object({
            op: z.literal("share"),
            name: KeyringSecretNameSchema,
            sandbox: sandboxUrl,
            machine: z.string().min(1).max(128),
            mode: KeyringShareModeSchema,
        })
        .strict(),
    z.object({ op: z.literal("unshare"), name: KeyringSecretNameSchema, sandbox: sandboxUrl }).strict(),
    z.object({ op: z.literal("backend"), config: BackendConfigSchema }).strict(),
    // What the machine relays for a sandbox (schemas/keyring.ts); `sandbox` is the link the call came in on, named by the
    // machine, never by the sandbox's own words.
    z.object({ op: z.literal("shares"), sandbox: sandboxUrl }).strict(),
    z.object({ op: z.literal("release"), grant: SignedKeyringGrantSchema }).strict(),
    z.object({ op: z.literal("type"), input: KeyringTypeInputSchema }).strict(),
    z.object({ op: z.literal("inbox"), item: KeyringInboxItemSchema }).strict(),
    z.object({ op: z.literal("copies"), sandbox: sandboxUrl }).strict(),
    z.object({ op: z.literal("sync-state") }).strict(),
    z.object({ op: z.literal("sync-pair"), pair: KeyringSyncPairSchema }).strict(),
    z.object({ op: z.literal("sync-outbox") }).strict(),
    z.object({ op: z.literal("sync-deliver"), deliver: KeyringSyncDeliverSchema }).strict(),
    // From intentic-askpass: the prompt ssh, sudo or git showed, answered with the value on a person's yes.
    z.object({ op: z.literal("askpass"), prompt: z.string().max(1000), parent: z.string().max(300).optional() }).strict(),
    // `intentic-machine keyring upgrade`: a new keyring binary is put in place only after the running one asked a person.
    z.object({ op: z.literal("consent-upgrade"), version: z.string().min(1).max(64) }).strict(),

    // ---- the Passwords app (2026-10-19) ----

    // A credential seen in use, sealed to the inbox key: taken in unasked when remembering is on for its source (kept
    // sealed while locked); relayed too, for a phone's autofill or a sandbox terminal's prompt, `sandbox` then being the
    // link it came in on, named by the machine.
    z.object({ op: z.literal("capture"), item: KeyringCaptureItemSchema, sandbox: sandboxUrl.optional() }).strict(),
    // An import: many at once, at one yes from the person ("Import 214 passwords from Chrome?").
    z.object({ op: z.literal("capture-batch"), items: z.array(KeyringCaptureItemSchema).min(1).max(KEYRING_CAPTURE_BATCH_MAX), from: z.string().min(1).max(200) }).strict(),
    // The toast's Undo: takes back what a capture at `at` did to `name` (removes a new entry, restores the value before).
    z.object({ op: z.literal("undo-capture"), name: KeyringSecretNameSchema, at: z.number().int() }).strict(),
    // Entries the person has looked at, so they leave "Just saved".
    z.object({ op: z.literal("seen"), names: z.array(KeyringSecretNameSchema).max(5000) }).strict(),
    // A value or user name for this computer's person: shown in the app (`reveal`), or put on the clipboard by the keyring
    // and cleared after `clearAfterSeconds` (`copy`). A password needs the person's yes; a user name does not.
    z.object({ op: z.literal("reveal"), name: KeyringSecretNameSchema, version: z.number().int().nonnegative().optional() }).strict(),
    z.object({ op: z.literal("copy"), name: KeyringSecretNameSchema, field: z.enum(["password", "username"]), clearAfterSeconds: z.number().int().min(5).max(300).default(30) }).strict(),
    // An entry's earlier values, newest first (never the values), and putting one back.
    z.object({ op: z.literal("history"), name: KeyringSecretNameSchema }).strict(),
    z.object({ op: z.literal("restore"), name: KeyringSecretNameSchema, version: z.number().int().nonnegative() }).strict(),
    z.object({ op: z.literal("settings") }).strict(),
    // Turning a remember switch on, or emptying the never-save list, asks; turning one off does not.
    z.object({ op: z.literal("set-settings"), patch: KeyringSettingsPatchSchema }).strict(),
    z.object({ op: z.literal("activity"), name: KeyringSecretNameSchema.optional(), limit: z.number().int().min(1).max(500).default(100) }).strict(),
    // Type an entry into the focused window here, at the person's own word (the session helper's "Fill with Intentic"
    // chip): asked with Windows Hello or polkit, typed after the usual window and field checks. No `name` and nothing
    // matches the focused program: the keyring's own box asks for the value once, types it and keeps it.
    z.object({ op: z.literal("fill-window"), name: KeyringSecretNameSchema.optional() }).strict(),
    // One entry's user name and value for a browser's field (the native host's `fill`), at the person's yes.
    z.object({ op: z.literal("fill-value"), origin: KeyringOriginSchema, name: KeyringSecretNameSchema }).strict(),
    // Names, titles and users serving a place: what a browser's or the app's fill offers. Never values.
    z.object({ op: z.literal("candidates"), origin: KeyringOriginSchema }).strict(),
    // An agent's need, relayed for a sandbox (`sandbox` is the link it came in on).
    z.object({ op: z.literal("need"), sandbox: sandboxUrl, need: KeyringNeedSchema }).strict(),
    // Needs nobody has answered yet, and the person's answer to one from the app.
    z.object({ op: z.literal("needs") }).strict(),
    z
        .object({
            op: z.literal("answer-need"),
            id: z.string().regex(KEYRING_NONCE_RE),
            answer: KeyringNeedAnswerSchema,
            name: KeyringSecretNameSchema.optional().describe("Which of the matches, when more than one fits."),
            sealed: SealedBoxSchema.optional().describe("Nothing matched: the value typed once in the app, sealed to the inbox key for a capture."),
            at: z.number().int().optional().describe("With `sealed`: the time bound into its seal, `{ kind: \"capture\", via: \"Passwords\", at }`."),
        })
        .strict(),
    // A phone, paired at the person's yes on both screens, then filling its autofill with a presence-signed request.
    z.object({ op: z.literal("phone-pair"), sandbox: sandboxUrl, phone: KeyringPhoneKeysSchema }).strict(),
    z.object({ op: z.literal("phone-fill"), sandbox: sandboxUrl, fill: SignedKeyringPhoneFillSchema }).strict(),
    // git's credential helper (`intentic-keyring git-credential get|erase`; its `store` is a `capture` with source `git`):
    // the value for an https remote at the person's yes, or word that the last one failed.
    z.object({ op: z.literal("git-credential"), action: z.enum(["get", "erase"]), url: z.string().url().max(500), username: z.string().max(256).optional() }).strict(),
]);
export type KeyringRequest = z.infer<typeof KeyringRequestSchema>;
export type KeyringOp = KeyringRequest["op"];

export const RefusalSchema = z.object({ ok: z.literal(false), code: KeyringRefusalCodeSchema, refusal: z.string() });
export type Refusal = z.infer<typeof RefusalSchema>;
// Generic over the granted object's fields rather than the object itself, so `.extend` keeps each op's own answer type.
const answer = <Fields extends z.core.$ZodLooseShape>(granted: z.ZodObject<Fields>) => z.discriminatedUnion("ok", [granted.extend({ ok: z.literal(true) }), RefusalSchema]);
const done = answer(z.object({}));

// Each op's answer, so the client parses exactly what its op promises.
export const KEYRING_RESPONSES = {
    state: answer(z.object({ state: KeyringStateSchema, setUp: z.boolean() })),
    setup: done,
    unlock: answer(z.object({ unlockedUntil: z.number() })),
    lock: done,
    list: answer(z.object({ entries: z.array(EntryInfoSchema), backends: z.array(z.enum(["1password", "bitwarden", "keepassxc"])) })),
    add: done,
    edit: done,
    remove: done,
    share: answer(z.object({ fingerprint: z.string().describe("The sandbox's signing key's fingerprint, as the prompt showed it.") })),
    unshare: done,
    backend: done,
    shares: answer(z.object({ pointers: z.array(KeyringPointerSchema) })),
    release: KeyringReleaseResultSchema,
    type: KeyringTypeResultSchema,
    inbox: KeyringInboxResultSchema,
    copies: answer(KeyringCopiesSchema),
    "sync-state": answer(z.object({ sync: KeyringSyncStateSchema })),
    "sync-pair": KeyringSyncPairResultSchema,
    "sync-outbox": answer(KeyringSyncOutboxSchema),
    "sync-deliver": answer(KeyringSyncDeliverResultSchema),
    askpass: answer(z.object({ value: z.string() })),
    "consent-upgrade": done,
    capture: KeyringCaptureResultSchema,
    "capture-batch": answer(z.object({ saved: z.number().int(), updated: z.number().int(), unchanged: z.number().int(), skipped: z.number().int() })),
    "undo-capture": done,
    seen: done,
    reveal: answer(z.object({ value: z.string(), username: z.string().optional() })),
    copy: answer(z.object({ clearsAt: z.number() })),
    history: answer(z.object({ versions: z.array(z.object({ version: z.number().int(), at: z.number(), captured: CapturedInfoSchema.optional() })) })),
    restore: done,
    settings: answer(
        z.object({
            settings: KeyringSettingsSchema,
            phones: z
                .array(z.object({ device: z.string(), label: z.string(), pairedAt: z.number() }))
                .optional()
                .describe("The phones paired to fill from this keyring, by name. Absent: none, or a keyring older than 2026-10-19."),
        }),
    ),
    "set-settings": answer(z.object({ settings: KeyringSettingsSchema })),
    activity: answer(z.object({ lines: z.array(ActivityItemSchema) })),
    "fill-window": answer(z.object({ name: KeyringSecretNameSchema, program: z.string(), saved: z.boolean() })),
    "fill-value": answer(z.object({ value: z.string(), username: z.string().optional() })),
    candidates: answer(z.object({ matches: z.array(z.object({ name: KeyringSecretNameSchema, title: z.string(), username: z.string().optional() })) })),
    need: KeyringNeedResultSchema,
    needs: answer(z.object({ pending: z.array(KeyringPendingNeedSchema) })),
    "answer-need": done,
    "phone-pair": KeyringPhonePairResultSchema,
    "phone-fill": KeyringPhoneFillResultSchema,
    "git-credential": answer(z.object({ value: z.string().optional(), username: z.string().optional() })),
} as const satisfies { readonly [K in KeyringOp]: z.ZodType };

export type KeyringResponse<K extends KeyringOp> = z.infer<(typeof KEYRING_RESPONSES)[K]>;

// A line longer than this is not a request any caller makes; the server drops the connection rather than buffer it.
export const KEYRING_LINE_MAX = 256 * 1024;
