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

// The one-time "let Intentic remember the passwords you type", per source. All off until the person turns them on;
// each switches off on its own. Imports, an agent's `secrets ask` and adding by hand are deliberate acts and need none.
export const KeyringRememberSchema = z.object({
    browser: z.boolean().describe("Sign-ins in a browser with the Intentic extension."),
    terminal: z.boolean().describe("ssh, sudo and git prompts on this computer, and git's credential helper."),
    apps: z.boolean().describe("Password fields in programs on this computer, typed once into the keyring's own box."),
    phone: z.boolean().describe("The paired phone's autofill."),
    sandbox: z.boolean().describe("Prompts that hide what is typed, in a sandbox terminal the person types into."),
});
export type KeyringRemember = z.infer<typeof KeyringRememberSchema>;

export const KeyringStateSchema = z.object({
    version: z.string().describe("The keyring's own release."),
    locked: z.boolean().describe("Whether the vault is locked. Locked, `while-here` entries ask like `each-use` ones."),
    unlockedUntil: z.number().optional().describe("When the current unlock ends, in milliseconds. Absent while locked."),
    unlock: z
        .array(z.enum(["hello", "passphrase", "polkit"]))
        .describe("How a person unlocks it here: Windows Hello, the keyring's passphrase (its recovery key), or polkit's own check on Linux."),
    keys: KeyringDeviceKeysSchema.optional().describe("Absent until the keyring is set up: there is no vault, so no inbox to seal a value to."),
    pendingInbox: z.number().int().nonnegative().describe("Values sent to be kept that wait for the next unlock."),
    pendingCaptures: z.number().int().nonnegative().optional().describe("Credentials seen in use while locked, kept sealed until the next unlock. Absent from a keyring older than 2026-10-19."),
    remember: KeyringRememberSchema.optional().describe("Which sources the person let the keyring remember passwords from, so a collector knows whether to send one. Absent before setup and from an older keyring."),
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
    .enum(["no-keyring", "locked", "declined", "unknown", "not-shared", "bad-grant", "expired", "replayed", "guard", "unavailable", "busy", "pending"])
    .describe(
        "Why: no keyring here; locked with nobody to unlock it; the person said no; no such entry; not shared with this sandbox; a grant that does not verify; one past its time; one already spent; the focused window or field is not one it may go to; its password manager did not answer; another prompt is open; nobody has answered yet, and the request waits in the Passwords app.",
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

// ---- origins: where a credential is used, and where it was seen ----

// One place a credential belongs to. An entry's rules (programs, packages, hosts, askpass matchers) are the keyring's
// own record of the same thing; policy/keyring-origins.ts maps one onto the other, so a captured credential gets its
// rules without anyone typing them and the Passwords app can say "Works on github.com, git https://github.com".
export const KeyringOriginSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("site"), host: z.string().min(1).max(253).describe("The page's host, `github.com`; never a path.") }).strict(),
    z
        .object({
            kind: z.literal("program"),
            program: KeyringProgramSchema,
            label: z.string().max(200).optional().describe("The program's own name for people, `FortiClient VPN`, when the window says it."),
        })
        .strict(),
    z.object({ kind: z.literal("package"), package: KeyringPackageSchema, label: z.string().max(200).optional() }).strict(),
    z.object({ kind: z.literal("ssh"), target: z.string().min(1).max(300).describe("`user@host`, as ssh's prompt names it.") }).strict(),
    z.object({ kind: z.literal("ssh-key"), path: z.string().min(1).max(1000) }).strict(),
    z.object({ kind: z.literal("sudo"), user: z.string().max(64).optional() }).strict(),
    z.object({ kind: z.literal("git"), url: z.string().min(1).max(500).describe("`https://host`, as git's credential helper or askpass names it.") }).strict(),
    z
        .object({
            kind: z.literal("prompt"),
            text: z.string().min(1).max(300).describe("The prompt's own words, `Password for npm:`."),
            command: z.string().max(200).optional().describe("The command that asked, `npm login`, when known."),
            sandbox: z.string().url().optional().describe("The sandbox whose terminal asked, for a prompt seen there rather than on this computer."),
        })
        .strict(),
]);
export type KeyringOrigin = z.infer<typeof KeyringOriginSchema>;

// Where a capture came from, for its title line ("saved from Brave") and its record.
export const KeyringCaptureSourceSchema = z
    .enum(["browser", "askpass", "git", "app", "phone", "terminal", "import", "agent", "manual"])
    .describe(
        "What saw it: the browser extension, an ssh/sudo/git prompt answered through the keyring, git's credential helper, a password field in an app on this computer, the phone's autofill, a sandbox terminal's prompt, an import, an agent's `secrets ask`, or the person adding it by hand.",
    );
export type KeyringCaptureSource = z.infer<typeof KeyringCaptureSourceSchema>;

// A credential seen in use, sent to be kept. The value is sealed to the vault's inbox key for `{ kind: "capture" }`
// (policy/keyring-seal.ts), so whoever carries it (the native-messaging host, the sandbox for a phone or a terminal)
// holds ciphertext. Taken in without asking once the person turned remembering on for its source: bringing a value IN
// reveals nothing, and an update keeps the old value in the entry's history, so a capture can be undone.
export const KEYRING_CAPTURE_BATCH_MAX = 5000;
export const KeyringCaptureItemSchema = z
    .object({
        origin: KeyringOriginSchema,
        username: z.string().max(256).optional().describe("The account it signs in as, when the form or prompt said. Not a secret."),
        sealed: SealedBoxSchema,
        source: KeyringCaptureSourceSchema,
        via: z.string().min(1).max(200).describe("Who saw it, in words for the title line: `Brave`, `Pixel 8`, `intentic-dev`. Also bound into the seal."),
        kind: z.enum(["password", "text"]).default("password"),
        title: z.string().max(200).optional().describe("The site's or app's own name, when it said one; the keyring derives one otherwise."),
        at: z.number().int().describe("When it was seen, in milliseconds. Also bound into the seal."),
        failed: z
            .boolean()
            .optional()
            .describe("The last value captured for this origin and user did not work (ssh asked again, git erased it, the form came back): replace it rather than keep it as history."),
    })
    .strict();
export type KeyringCaptureItem = z.infer<typeof KeyringCaptureItemSchema>;

export const KeyringCaptureOutcomeSchema = z
    .enum(["saved", "updated", "unchanged", "pending", "skipped"])
    .describe(
        "A new entry; a new value for an existing one (the old kept in its history); the same value it already had; kept sealed until the next unlock; not kept, because remembering is off for its source or its origin is on the never-save list.",
    );
export type KeyringCaptureOutcome = z.infer<typeof KeyringCaptureOutcomeSchema>;

export const KeyringCaptureResultSchema = z.discriminatedUnion("ok", [
    z.object({
        ok: z.literal(true),
        outcome: KeyringCaptureOutcomeSchema,
        name: KeyringSecretNameSchema.optional().describe("The entry it went to. Absent while pending or skipped."),
        title: z.string().optional().describe("That entry's title, for the 'Saved github.com' notice."),
    }),
    refusal,
]);
export type KeyringCaptureResult = z.infer<typeof KeyringCaptureResultSchema>;

// ---- an agent's need: asked for by what it is for, not by name ----

// A sandbox asking for a credential by where it is to be used. The keyring matches its entries by origin and asks the
// person (with their OS's own check: Windows Hello, polkit, a phone's biometric signature) whether this sandbox may use
// the one it found, and on what terms. Nothing about entries that do not match, nor about one the person declines,
// reaches the sandbox. A match nobody answers waits in the Passwords app's Requests, and the sandbox learns of the yes
// from its next `shares` read.
export const KeyringNeedSchema = z
    .object({
        origin: KeyringOriginSchema,
        username: z.string().max(256).optional().describe("The account wanted, when the agent knows it."),
        detail: z.string().min(1).max(300).describe("What it is for, in words for the prompt: `sign in to push the release branch`."),
        conversation: z.string().max(200).optional(),
        purpose: z.enum(["agent", "owner"]).default("agent"),
        typeOnce: z
            .boolean()
            .default(false)
            .describe(
                "Nothing matched on any of the owner's computers: offer the person here the keyring's type-once box. Without it, a keyring with no match answers `unknown` at once, so the sandbox can ask the next computer without a box opening on each.",
            ),
    })
    .strict();
export type KeyringNeed = z.infer<typeof KeyringNeedSchema>;

export const KeyringNeedAnswerSchema = z
    .enum(["once", "while-here", "always", "deny"])
    .describe("The person's answer: this one use (an `each-use` share), unasked while unlocked, a copy in the sandbox, or no.");
export type KeyringNeedAnswer = z.infer<typeof KeyringNeedAnswerSchema>;

export const KeyringNeedResultSchema = z.discriminatedUnion("ok", [
    z.object({
        ok: z.literal(true),
        pointer: KeyringPointerSchema.describe("The entry now shared with the asking sandbox, as its next `shares` read will also list it."),
        asked: z.boolean(),
        saved: z.boolean().describe("Nothing matched, and the person typed it once into the keyring's own box: a new entry, kept here and shared."),
    }),
    refusal,
]);
export type KeyringNeedResult = z.infer<typeof KeyringNeedResultSchema>;

// A need that waits for an answer, as the Passwords app lists it.
export const KeyringPendingNeedSchema = z.object({
    id: z.string().regex(KEYRING_NONCE_RE),
    sandbox: z.string().url(),
    need: KeyringNeedSchema,
    matches: z.array(KeyringSecretNameSchema).describe("The entries that fit, best first. Empty: none yet, the app offers to type one once."),
    at: z.number().int(),
});
export type KeyringPendingNeed = z.infer<typeof KeyringPendingNeedSchema>;

// ---- the owner's phone as a place to save and fill ----

// A phone paired with the keyring holds two keys made in its Android Keystore: `seal` (X25519, kept in software, which
// Android's Keystore cannot do natively) that a value released for autofill is sealed to, and `presence` (ECDSA P-256,
// `setUserAuthenticationRequired`, so it signs only after the person's fingerprint, face or screen lock). A signature by
// `presence` over a fill request is the person's yes, checked by the keyring against the key it pinned at pairing, the
// way a Windows Hello signature is. Pairing is carried by a sandbox both are linked to, with both fingerprints shown.
export const KeyringPhoneKeysSchema = z
    .object({
        device: z.string().min(1).max(128).describe("The phone, by its device card."),
        label: z.string().min(1).max(200).describe("The phone's name for people, `Pixel 8`."),
        seal: KeyringPublicKeySchema,
        presence: z.string().min(1).max(512).describe("The presence key, X.509 SubjectPublicKeyInfo DER, base64."),
    })
    .strict();
export type KeyringPhoneKeys = z.infer<typeof KeyringPhoneKeysSchema>;

export const KeyringPhonePairResultSchema = z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), fingerprint: z.string().describe("The keyring's own fingerprint, for the phone to show beside its own.") }),
    refusal,
]);
export type KeyringPhonePairResult = z.infer<typeof KeyringPhonePairResultSchema>;

export const KeyringPhoneFillSchema = z
    .object({
        v: z.literal(1),
        device: z.string().min(1).max(128),
        origin: KeyringOriginSchema.describe("Where the phone is filling: a `package`, or a `site` for a browser on the phone."),
        username: z.string().max(256).optional(),
        nonce: z.string().regex(KEYRING_NONCE_RE),
        issuedAt: z.number().int(),
        expiresAt: z.number().int(),
    })
    .strict();
export type KeyringPhoneFill = z.infer<typeof KeyringPhoneFillSchema>;

export const SignedKeyringPhoneFillSchema = z
    .object({
        payload: z.string().min(1).max(4096).describe("The fill request's JSON, base64url."),
        sig: z.string().min(1).max(256).describe("The presence key's ECDSA P-256 signature (DER) over the payload, base64url."),
    })
    .strict();
export type SignedKeyringPhoneFill = z.infer<typeof SignedKeyringPhoneFillSchema>;

export const KeyringPhoneFillResultSchema = z.discriminatedUnion("ok", [
    z.object({
        ok: z.literal(true),
        username: z.string().max(256).optional(),
        sealed: SealedBoxSchema.describe("The value, sealed to the phone's `seal` key for `{ kind: \"phone\" }`."),
        name: KeyringSecretNameSchema,
        title: z.string(),
    }),
    refusal,
]);
export type KeyringPhoneFillResult = z.infer<typeof KeyringPhoneFillResultSchema>;
