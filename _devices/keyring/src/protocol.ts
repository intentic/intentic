import { z } from "zod";
import {
    KEYRING_PROGRAMS_MAX,
    KeyringCopiesSchema,
    KeyringInboxItemSchema,
    KeyringInboxResultSchema,
    KeyringPackageSchema,
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
} from "@intentic/sandbox-contract";

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

export const EntryInfoSchema = z.object({
    name: KeyringSecretNameSchema,
    ...entryRules,
    source: KeyringSourceSchema,
    backend: BackendRefSchema.optional(),
    shares: z.array(ShareInfoSchema),
    createdAt: z.number(),
    updatedAt: z.number(),
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
} as const satisfies { readonly [K in KeyringOp]: z.ZodType };

export type KeyringResponse<K extends KeyringOp> = z.infer<(typeof KEYRING_RESPONSES)[K]>;

// A line longer than this is not a request any caller makes; the server drops the connection rather than buffer it.
export const KEYRING_LINE_MAX = 256 * 1024;
