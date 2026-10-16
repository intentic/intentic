import { z } from "zod";

// Secrets that live in a keyring on the owner's own computer (`intentic-keyring`, a process of its own beside
// intentic-machine) rather than in the sandbox. The sandbox holds a POINTER to each one shared with it, never the value,
// and asks for a value by sending a grant it signed: the machine relays the grant to the keyring and the answer back,
// and the answer is sealed to whoever the grant names, so the machine carries only ciphertext. What a grant may ask for
// is the keyring's to decide (its share mode, its program list, a person's tap); the sandbox's own gates run first.
// The sealing and signing themselves are policy/keyring-seal.ts.

// Raw 32-byte keys travel as base64url without padding, the `x` of their JWK: X25519 for sealing, Ed25519 for signing.
export const KEYRING_KEY_RE = /^[A-Za-z0-9_-]{43}$/u;
export const KeyringPublicKeySchema = z.string().regex(KEYRING_KEY_RE).describe("A raw 32-byte public key, base64url without padding.");

// One secret's name, the same shape a sandbox secret's name and a reference to it take (SECRET_KEY_RE), so a shared
// entry is spent, typed and listed exactly like a sandbox-held one.
export const KEYRING_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
export const KeyringSecretNameSchema = z
    .string()
    .regex(KEYRING_NAME_RE)
    .describe("The secret's name, as a reference to it carries it: a letter or underscore, then letters, digits or `_`.");

export const KeyringShareModeSchema = z
    .enum(["each-use", "while-here", "copy"])
    .describe(
        "How the keyring answers this sandbox: `each-use` asks the person at the computer every time (Windows Hello, or the keyring's passphrase); `while-here` answers unasked while the keyring is unlocked, for as long as the unlock lasts; `copy` keeps a copy in the sandbox, so it works with the computer off, which makes it an ordinary sandbox secret.",
    );
export type KeyringShareMode = z.infer<typeof KeyringShareModeSchema>;

// A program a value may be typed into without asking: an executable's file name (`FortiClient.exe`, matched without case)
// or its whole path. Android apps are package names, kept apart in `packages`.
export const KEYRING_PROGRAM_MAX = 260;
export const KeyringProgramSchema = z
    .string()
    .min(1)
    .max(KEYRING_PROGRAM_MAX)
    .refine((value) => !/[\0\r\n]/u.test(value), "one program per entry, no line breaks")
    .describe("A program, by its executable's file name (`FortiClient.exe`, `mstsc.exe`, `ssh`) or its whole path.");
export const KEYRING_PACKAGE_RE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/u;
export const KeyringPackageSchema = z.string().regex(KEYRING_PACKAGE_RE).max(255).describe("An Android app, by its package name (`com.fortinet.forticlient`).");
export const KEYRING_PROGRAMS_MAX = 32;

export const KeyringSourceSchema = z
    .enum(["keyring", "bitwarden", "1password", "keepassxc"])
    .describe("Where the value itself is read from when it is used: the keyring's own vault, or a password manager the keyring reads it from.");
export type KeyringSource = z.infer<typeof KeyringSourceSchema>;

// What the keyring tells a sandbox about one entry shared with it: everything the sandbox needs to list it, mask it
// once released and judge a use before asking, never the value.
export const KeyringPointerSchema = z.object({
    name: KeyringSecretNameSchema,
    mode: KeyringShareModeSchema,
    kind: z.enum(["password", "text"]).describe("A password, typed only into a password field unless `anyField` says otherwise; or text, typed anywhere a program on the list has focus."),
    programs: z
        .array(KeyringProgramSchema)
        .max(KEYRING_PROGRAMS_MAX)
        .describe("Programs on this computer it may be typed into without asking. Empty: typing it into any window asks the person at the computer."),
    packages: z.array(KeyringPackageSchema).max(KEYRING_PROGRAMS_MAX).describe("Android apps on a phone attached to this computer it may be typed into."),
    hosts: z
        .array(z.string().min(1).max(253))
        .max(KEYRING_PROGRAMS_MAX)
        .describe("Sites it may be typed into or sent to, exact or `*.domain`, the same shape as a sandbox secret's host guard."),
    anyField: z.boolean().describe("Whether it may be typed into a field the program does not mark as a password field."),
    source: KeyringSourceSchema,
    updatedAt: z.number().describe("When the entry last changed, in milliseconds."),
});
export type KeyringPointer = z.infer<typeof KeyringPointerSchema>;

// The keyring's own public keys: `seal` for a value the sandbox sends it to type (a sandbox-held secret, or one another
// computer released for this one), `inbox` for a value sent to be kept, readable only once the vault is unlocked.
export const KeyringDeviceKeysSchema = z.object({
    seal: KeyringPublicKeySchema.describe("Seals a value this keyring is asked to type. Its private half sits beside the vault, readable while locked."),
    inbox: KeyringPublicKeySchema.describe("Seals a value sent to be kept. Its private half is inside the vault, so nothing reads an inbox item until a person unlocks it."),
});
export type KeyringDeviceKeys = z.infer<typeof KeyringDeviceKeysSchema>;

// A sandbox's own keyring keys, served unauthenticated at GET /keyring/keys so a keyring can fetch them over TLS from the
// sandbox's address itself rather than take them from whoever relays a share: `sign` verifies its grants, `seal` is what
// a released value is sealed to.
export const KeyringSandboxKeysSchema = z.object({
    sign: KeyringPublicKeySchema.describe("Verifies the grants this sandbox signs (Ed25519)."),
    seal: KeyringPublicKeySchema.describe("What a value released to this sandbox is sealed to (X25519)."),
});
export type KeyringSandboxKeys = z.infer<typeof KeyringSandboxKeysSchema>;

export const KeyringStateSchema = z.object({
    version: z.string().describe("The keyring's own release."),
    locked: z.boolean().describe("Whether the vault is locked. Locked, `while-here` entries ask like `each-use` ones."),
    unlockedUntil: z.number().optional().describe("When the current unlock ends, in milliseconds. Absent while locked."),
    unlock: z
        .array(z.enum(["hello", "passphrase"]))
        .describe("How a person unlocks it here: Windows Hello, or the keyring's passphrase."),
    keys: KeyringDeviceKeysSchema.optional().describe("Absent until the keyring is set up: there is no vault, so no inbox to seal a value to."),
    pendingInbox: z.number().int().nonnegative().describe("Values sent to be kept that wait for the next unlock."),
});
export type KeyringState = z.infer<typeof KeyringStateSchema>;

// The machine's answer to `keyringShares`: the keyring's state and the entries shared with the asking sandbox. Absent
// `keyring`: none is installed, or it does not answer.
export const KeyringSharesSchema = z.object({
    keyring: KeyringStateSchema.optional().describe("The keyring on this computer. Absent when none is installed or it does not answer."),
    pointers: z.array(KeyringPointerSchema).describe("The entries shared with the sandbox asking. Names and rules only, never values."),
    reason: z.string().optional().describe("Why there is no keyring to speak of, in words, when there is not."),
});
export type KeyringShares = z.infer<typeof KeyringSharesSchema>;

// ---- grants ----

export const KeyringLaneSchema = z
    .enum(["shell", "code", "browser", "desktop"])
    .describe("Where in the sandbox a released value goes: a command, a script, a page in a sandbox browser, a window on the sandbox's desktop.");

// What a grant asks the keyring to do with one value.
export const KeyringGrantTargetSchema = z.discriminatedUnion("kind", [
    // Hand the value to the sandbox, sealed to its pinned `seal` key, for one use in one lane.
    z.object({ kind: z.literal("sandbox"), lane: KeyringLaneSchema }),
    // Type it into the focused window on this computer. `programs` and `anyField` are the sandbox's own guard for a
    // value it sent; for the keyring's own entry the keyring's list is the one in force and these only narrow it.
    z.object({
        kind: z.literal("window"),
        programs: z.array(KeyringProgramSchema).max(KEYRING_PROGRAMS_MAX),
        anyField: z.boolean(),
        // The owner's own Type into…, from the editor: a moment to put the cursor where the value goes.
        countdownSeconds: z.number().int().min(0).max(10).optional(),
    }),
    // Type it on an Android phone attached to this computer, into one of these apps.
    z.object({ kind: z.literal("android"), serial: z.string().min(1).max(128), packages: z.array(KeyringPackageSchema).max(KEYRING_PROGRAMS_MAX) }),
    // Seal it to another computer's keyring, which the sandbox then asks to type it: the value goes computer to computer
    // and the sandbox carries only ciphertext.
    z.object({ kind: z.literal("relay"), sealTo: KeyringPublicKeySchema, toMachine: z.string().min(1).max(128) }),
]);
export type KeyringGrantTarget = z.infer<typeof KeyringGrantTargetSchema>;

// A grant lives two minutes at most: long enough for a person to answer a Windows Hello prompt, short enough that one
// lifted from a log is spent or stale.
export const KEYRING_GRANT_TTL_MAX_MS = 2 * 60_000;
export const KEYRING_NONCE_RE = /^[A-Za-z0-9_-]{22}$/u;

export const KeyringGrantSchema = z
    .object({
        v: z.literal(1),
        sandbox: z.string().url().describe("The sandbox's own address: which share this grant spends, and whose signing key verifies it."),
        secret: KeyringSecretNameSchema,
        target: KeyringGrantTargetSchema,
        purpose: z.enum(["agent", "owner"]).describe("Whether an agent asked for this use, or the owner did from the editor's Type into…."),
        conversation: z.string().max(200).optional().describe("The conversation the use is for, shown in the keyring's prompt and its record."),
        detail: z.string().min(1).max(300).describe("What the use is, in words, for the person answering the prompt: the command's start, the site, the window."),
        nonce: z.string().regex(KEYRING_NONCE_RE).describe("16 random bytes, base64url: a grant answers once."),
        issuedAt: z.number().int(),
        expiresAt: z.number().int(),
    })
    .strict();
export type KeyringGrant = z.infer<typeof KeyringGrantSchema>;

export const SignedKeyringGrantSchema = z
    .object({
        payload: z.string().min(1).max(8192).describe("The grant's JSON, base64url."),
        sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/u).describe("The sandbox's Ed25519 signature over the grant, base64url."),
    })
    .strict();
export type SignedKeyringGrant = z.infer<typeof SignedKeyringGrantSchema>;

// X25519 to the recipient's key with a fresh key per box, HKDF-SHA256, AES-256-GCM; the additional data binds a box to
// what it was sealed for (policy/keyring-seal.ts), so one cannot be replayed as another.
export const SealedBoxSchema = z
    .object({
        v: z.literal(1),
        epk: KeyringPublicKeySchema.describe("The sender's one-time public key."),
        iv: z.string().regex(/^[A-Za-z0-9_-]{16}$/u),
        tag: z.string().regex(/^[A-Za-z0-9_-]{22}$/u),
        data: z.string().max(65536).regex(/^[A-Za-z0-9_-]*$/u),
    })
    .strict();
export type SealedBox = z.infer<typeof SealedBoxSchema>;

export const KeyringRefusalCodeSchema = z
    .enum(["no-keyring", "locked", "declined", "unknown", "not-shared", "bad-grant", "expired", "replayed", "guard", "unavailable", "busy"])
    .describe(
        "Why: no keyring here; locked with nobody to unlock it; the person said no; no such entry; not shared with this sandbox; a grant that does not verify; one past its time; one already spent; the focused window or field is not one it may go to; its password manager did not answer; another prompt is open.",
    );
export type KeyringRefusalCode = z.infer<typeof KeyringRefusalCodeSchema>;

const refusal = z.object({ ok: z.literal(false), code: KeyringRefusalCodeSchema, refusal: z.string().describe("What happened, in words a person can act on.") });

export const KeyringReleaseResultSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), sealed: SealedBoxSchema, asked: z.boolean().describe("Whether the person at the computer was asked.") }),
    refusal,
]);
export type KeyringReleaseResult = z.infer<typeof KeyringReleaseResultSchema>;

export const KeyringTypeInputSchema = z
    .object({
        grant: SignedKeyringGrantSchema,
        // A value the keyring does not hold itself: a sandbox-held secret, or one another computer released for this one,
        // sealed to this keyring's `seal` key.
        sealed: SealedBoxSchema.optional(),
    })
    .strict();
export type KeyringTypeInput = z.infer<typeof KeyringTypeInputSchema>;

export const KeyringTypeResultSchema = z.discriminatedUnion("ok", [
    z.object({
        ok: z.literal(true),
        program: z.string().describe("The program it was typed into: its executable's file name, or the Android app's package."),
        field: z.enum(["password", "text"]).describe("Whether the focused field was a password field."),
        asked: z.boolean().describe("Whether the person at the computer was asked."),
    }),
    refusal,
]);
export type KeyringTypeResult = z.infer<typeof KeyringTypeResultSchema>;

// A value sent from the sandbox to be kept in this computer's keyring (a `secrets ask` answered with "keep it on my
// computer"), sealed to the vault's inbox key and taken in at the next unlock, when the person sees its name and says yes.
export const KeyringInboxItemSchema = z
    .object({
        name: KeyringSecretNameSchema,
        sealed: SealedBoxSchema,
        mode: KeyringShareModeSchema,
        kind: z.enum(["password", "text"]),
        programs: z.array(KeyringProgramSchema).max(KEYRING_PROGRAMS_MAX),
        hosts: z.array(z.string().min(1).max(253)).max(KEYRING_PROGRAMS_MAX),
        sandbox: z.string().url().describe("The sandbox it came from, which it is shared with once taken in."),
    })
    .strict();
export type KeyringInboxItem = z.infer<typeof KeyringInboxItemSchema>;

export const KeyringInboxResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), pending: z.boolean().describe("Whether it waits for the next unlock.") }), refusal]);
export type KeyringInboxResult = z.infer<typeof KeyringInboxResultSchema>;

// `copy` entries, sealed to the asking sandbox's key, for the sandbox to keep as its own; asked for on connect and after
// a change, so an edit on the computer reaches the copy.
export const KeyringCopiesSchema = z.object({
    copies: z.array(z.object({ name: KeyringSecretNameSchema, sealed: SealedBoxSchema, updatedAt: z.number() })),
});
export type KeyringCopies = z.infer<typeof KeyringCopiesSchema>;

// ---- sync between the owner's computers ----

// Keyrings on two of the owner's computers keep one set of entries by sealing each change to the other's sync key and
// leaving it in a sandbox both link to, which carries only ciphertext and never a key that opens it. Two keyrings are
// paired once, at a person's word on each computer, each showing both fingerprints to compare; a sandbox that swapped a
// key would show a fingerprint the other screen does not.
export const KeyringSyncPeerSchema = z.object({
    device: z.string().min(1).max(128).describe("The other computer, by its device card."),
    key: KeyringPublicKeySchema.describe("Its keyring's sync key."),
    pairedAt: z.number().describe("When the two were paired, in milliseconds."),
});
export type KeyringSyncPeer = z.infer<typeof KeyringSyncPeerSchema>;

export const KeyringSyncStateSchema = z.object({
    key: KeyringPublicKeySchema.describe("This keyring's own sync key."),
    peers: z.array(KeyringSyncPeerSchema).describe("The keyrings it keeps in step with."),
    revision: z.number().int().nonnegative().describe("How many changes this keyring has made, for ordering what it sends."),
});
export type KeyringSyncState = z.infer<typeof KeyringSyncStateSchema>;

export const KeyringSyncItemSchema = z
    .object({
        from: KeyringPublicKeySchema.describe("The sending keyring's sync key."),
        to: KeyringPublicKeySchema.describe("The receiving keyring's sync key."),
        revision: z.number().int().nonnegative(),
        sealed: SealedBoxSchema.describe("The sender's entries, sealed to the receiver for `sync` with its own revision."),
    })
    .strict();
export type KeyringSyncItem = z.infer<typeof KeyringSyncItemSchema>;

export const KeyringSyncPairSchema = z
    .object({
        peer: z.object({ device: z.string().min(1).max(128), key: KeyringPublicKeySchema }).strict(),
        // The device card this keyring's own computer is known by, so the prompt can name both.
        self: z.string().min(1).max(128),
    })
    .strict();

export const KeyringSyncPairResultSchema = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true) }), refusal]);
export const KeyringSyncOutboxSchema = z.object({ items: z.array(KeyringSyncItemSchema) });
export const KeyringSyncDeliverSchema = z.object({ items: z.array(KeyringSyncItemSchema).max(64) }).strict();
export const KeyringSyncDeliverResultSchema = z.object({ accepted: z.number().int().nonnegative().describe("How many it took; the rest were not from a paired keyring or did not open.") });
