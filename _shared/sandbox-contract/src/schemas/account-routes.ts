import { z } from "zod";

// ROUTING AS A PERSON, the pairing (docs/architecture/account-routing.md, 2026-11-24). A scope other than `report` is
// admitted only beside a secret the person minted at the receiving sandbox and handed to the asking one, so the
// platform's pass alone opens nothing but an inbox. The person's own editor carries it, being signed in to both: it
// mints the secret at the target (`POST /account/pairings`), which keeps only its hash, and stores it here
// (`POST /account/routes/secret`), beside the vault, where no agent reads it.

// A tunnel id, as the platform names a sandbox to another (twelve lowercase hex characters).
const TunnelIdSchema = z.string().regex(/^[0-9a-f]{12}$/);

// At the receiving sandbox: the signed-in person pairs the asking sandbox `from` with themselves.
export const PairingMintSchema = z.object({
    from: TunnelIdSchema.describe("The asking sandbox's tunnel id."),
    fromName: z.string().trim().min(1).max(120).describe("Its name, for the list of pairings; display only."),
});
export type PairingMint = z.infer<typeof PairingMintSchema>;

// The secret, answered once; only its hash stays.
export const PairingMintedSchema = z.object({
    from: z.string(),
    person: z.string(),
    secret: z.string().describe("The pairing secret: hand it to the asking sandbox, which sends it beside every routed request."),
    createdAt: z.number(),
});
export type PairingMinted = z.infer<typeof PairingMintedSchema>;

// One pairing as the receiving sandbox keeps it, without its hash.
export const PairingSchema = z.object({
    from: z.string(),
    fromName: z.string(),
    person: z.string(),
    createdAt: z.number(),
});
export type Pairing = z.infer<typeof PairingSchema>;
export const PairingsListSchema = z.object({ pairings: z.array(PairingSchema) });
export type PairingsList = z.infer<typeof PairingsListSchema>;

// At the asking sandbox: the secret the signed-in person minted at `target`, to keep for routing as them there.
export const RouteSecretSchema = z.object({
    target: TunnelIdSchema.describe("The target sandbox's tunnel id."),
    secret: z.string().min(32).max(200),
});
export type RouteSecret = z.infer<typeof RouteSecretSchema>;

// What the asking sandbox holds, never the secrets.
export const RouteHeldSchema = z.object({ target: z.string(), person: z.string(), createdAt: z.number() });
export type RouteHeld = z.infer<typeof RouteHeldSchema>;
export const RoutesListSchema = z.object({ routes: z.array(RouteHeldSchema) });
export type RoutesList = z.infer<typeof RoutesListSchema>;

// A DROP (2026-11-24, docs/architecture/account-routing.md): a note and files one of a person's sandboxes hands another
// that person is in, landing in its inbox on the history volume and starting no turn. Bounded so one drop is one POST.
export const DROP_NOTE_MAX = 4_000;
export const DROP_FILES_MAX = 20;
export const DROP_BYTES_MAX = 10 * 1024 * 1024;
// A file's own name, never a path: it lands in the drop's folder as itself.
const DropFileNameSchema = z
    .string()
    .min(1)
    .max(200)
    .refine((name) => !/[/\\\0]/u.test(name) && name !== "." && name !== "..", "a file's own name, without a directory");
const DropNoteSchema = z.string().max(DROP_NOTE_MAX);
// A conversation id as the receiving sandbox names its own.
const ConversationIdSchema = z.string().min(1).max(120);
// One file: its name and its bytes in base64.
export const DropFileSchema = z.object({ name: DropFileNameSchema, data: z.string() });

// The loopback send (`sandboxes send`): the target sandbox by name or id, and the files as the command read them. The
// command reads them itself, as the agent, so the daemon never opens a path an agent names (its own state included).
export const DropSendSchema = z.object({
    sandbox: z.string().trim().min(1).max(120),
    files: z.array(DropFileSchema).max(DROP_FILES_MAX).default([]),
    note: DropNoteSchema.optional(),
    wake: ConversationIdSchema.optional().describe("Queue the note into this conversation of the person's there, while a turn of it runs."),
});
export type DropSend = z.infer<typeof DropSendSchema>;

// What the send came to: the outbox's answer, or the person's card it raised instead of sending.
export const DropSendOutcomeSchema = z.discriminatedUnion("state", [
    z.object({ state: z.literal("delivered"), to: z.string(), id: z.string() }),
    z.object({ state: z.literal("queued"), to: z.string().optional(), reason: z.string(), times: z.number() }),
    z.object({ state: z.literal("refused"), reason: z.string() }),
    z.object({ state: z.literal("asked"), reason: z.string(), needId: z.string() }),
]);
export type DropSendOutcome = z.infer<typeof DropSendOutcomeSchema>;

// The wire, daemon to daemon (`POST /account/drop`, `?wake=<conversation>`): one JSON body, every file's bytes in
// base64 beside its name, the shape the outbox's postToDoor already sends. The sender's drop id makes a retry land once.
export const DropBodySchema = z.object({
    id: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/u),
    note: DropNoteSchema.optional(),
    conversationId: z.string().max(120).optional().describe("The sending conversation, for the record; display only."),
    files: z.array(DropFileSchema).max(DROP_FILES_MAX),
});
export type DropBody = z.infer<typeof DropBodySchema>;
// Base64 is four bytes for three, plus the note and the names.
export const DROP_BODY_MAX = Math.ceil((DROP_BYTES_MAX * 4) / 3) + 256 * 1024;
export const DropAcceptedSchema = z.object({ ok: z.literal(true), id: z.string(), woke: z.boolean().optional() });

// One drop as the receiving sandbox keeps it (its manifest), as the inbox lists it.
export const ReceivedDropSchema = z.object({
    id: z.string(),
    from: z.object({ sandboxId: z.string(), sandboxName: z.string() }),
    person: z.string(),
    // Set when the two sandboxes are not in one organisation, as the pass said (a side in none is absent).
    crossesOrg: z
        .object({ from: z.object({ id: z.string(), name: z.string() }).optional(), to: z.object({ id: z.string(), name: z.string() }).optional() })
        .optional(),
    note: z.string().optional(),
    files: z.array(z.object({ name: z.string(), size: z.number() })),
    receivedAt: z.number(),
    // The conversation it asked to be queued into, and whether a turn of it was running to take it.
    wake: z.object({ conversationId: z.string(), delivered: z.boolean() }).optional(),
});
export type ReceivedDrop = z.infer<typeof ReceivedDropSchema>;
export const ReceivedDropsSchema = z.object({ drops: z.array(ReceivedDropSchema) });
export type ReceivedDrops = z.infer<typeof ReceivedDropsSchema>;
// Taking a drop copies its files into a folder of the workspace (workspace-relative, or absolute under it).
export const DropTakeSchema = z.object({ dest: z.string().min(1).max(1000) });
export type DropTake = z.infer<typeof DropTakeSchema>;
export const DropTakenSchema = z.object({ dest: z.string(), files: z.array(z.string()) });
export type DropTaken = z.infer<typeof DropTakenSchema>;
// A drop's files whole, for the `inbox take` command, which writes them where its own shell sees the destination.
export const DropFilesSchema = z.object({ files: z.array(DropFileSchema) });
export type DropFiles = z.infer<typeof DropFilesSchema>;
