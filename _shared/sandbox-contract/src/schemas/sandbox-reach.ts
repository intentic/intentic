import { z } from "zod";
import { MemberTierSchema } from "./shared.js";

// ONE SANDBOX'S TIES TO EVERYTHING OUTSIDE IT, as the person reading may see them (GET /system/reach). The editor asks
// every sandbox an account reaches for this answer and joins them into the account's access map (Settings ▸ Access
// map, docs/architecture/accounts.md): the other sandboxes this one hands work to and takes work from, the computers
// and servers its agents reach, and whether it may create sandboxes on its owner's account. Each daemon answers for
// its own ties alone, from what it stores and enforces, so the platform never learns them.
//
// Nothing here is a credential: no token, no address path, no secret. What joins two answers is an id both sides hold:
// a sandbox's platform id (else its address's host name), a computer's machine id (else its host name), a server's
// host name. Open sets (a link's answer, a device's kind, the switches it has on) are strings rather than enums, so a
// value a newer daemon adds never fails an older editor's parse; the known values are named below.

/** What a link's far side answered the last time this sandbox asked it (`GET /link`). */
export const REACH_LINK_ANSWERS = ["answering", "silent", "revoked"] as const;
export type ReachLinkAnswer = (typeof REACH_LINK_ANSWERS)[number];

/** What kind of thing a device card connects. */
export const REACH_DEVICE_KINDS = ["computer", "phone", "browser"] as const;
export type ReachDeviceKind = (typeof REACH_DEVICE_KINDS)[number];

/**
 * A device card's switches that let an agent or a person act on the machine, in the order they are said. A card's
 * switch that is on and named here is listed in `grants`; `roots` and the rest are settings, not grants.
 */
export const REACH_DEVICE_GRANTS = [
    "shell",
    "write",
    "screen",
    "control",
    "sandboxes",
    "destructive",
    "admin",
    "programs",
    "remoteView",
    "remoteControl",
    "remoteTerminal",
] as const;
export type ReachDeviceGrant = (typeof REACH_DEVICE_GRANTS)[number];

/** The grants that let whoever holds them act on the machine as themselves (run, change or drive it), not only look. */
export const REACH_DEVICE_ACTING_GRANTS: readonly ReachDeviceGrant[] = ["shell", "write", "control", "destructive", "programs", "remoteControl", "remoteTerminal", "admin"];

/** A link's terms as the taking sandbox sets them, in the words both ends of a tie read. */
export const ReachLinkTermsSchema = z.object({
    tasks: z.boolean().describe("Its agents may hand that sandbox tasks."),
    records: z.boolean().describe("They may read that sandbox's conversations and diagnostics."),
    operate: z.boolean().describe("They may run commands and read and write files there, as its owner's terminal would."),
    approve: z.boolean().describe("Each new task waits for that sandbox's owner to allow it."),
    role: z.string().optional().describe("The name of the role its tasks wear there; absent, they wear none."),
});
export type ReachLinkTerms = z.infer<typeof ReachLinkTermsSchema>;

// How many other people here may use one card through their own conversations: the owner and everyone on the roster
// who runs agents here and whose own access reaches the card. Only for a reader who runs people and access.
const othersField = z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("How many other people here may have their own agents use it. Absent when the roster is not the reader's to read.");

// Whether the reader's own conversations here may use one card: they run agents here, and their access reaches it.
const yoursField = z.boolean().describe("Whether the reader's own conversations here may use it.");

/** A `link` card here: this sandbox's agents may hand work to that one, under that sandbox's terms. */
export const ReachLinkOutSchema = z.object({
    card: z.string().describe("The card's id here: what this sandbox's agents hand work `to`."),
    name: z.string().optional().describe("What the other sandbox is called, as pairing named it."),
    sandboxId: z.string().optional().describe("The other sandbox's platform id, when pairing named it."),
    host: z.string().describe("The host name of the other sandbox's address, the join key when no id was named."),
    answer: z.string().describe("What it answered when last asked: answering, silent (off or unreachable) or revoked."),
    terms: ReachLinkTermsSchema.optional().describe("Its terms as the other sandbox last said them; absent while it has not answered."),
    yours: yoursField,
    others: othersField,
});
export type ReachLinkOut = z.infer<typeof ReachLinkOutSchema>;

/** An inbound link here: that sandbox's agents may hand work to this one, under the terms this sandbox's owner set. */
export const ReachLinkInSchema = z.object({
    id: z.string(),
    label: z.string().describe("What the asking sandbox is called here."),
    sandboxId: z.string().optional().describe("The asking sandbox's platform id, when pairing named it."),
    host: z.string().optional().describe("The host name of the asking sandbox's address, when pairing named it."),
    terms: ReachLinkTermsSchema.extend({
        runAs: z.string().optional().describe("The name of the service its tasks act as; absent, they act for this sandbox's owner."),
    }),
    lastUsedAt: z.number().optional().describe("When it was last used, epoch milliseconds; absent means never."),
    waiting: z.number().int().nonnegative().describe("Tasks it handed over that wait for this sandbox's owner."),
});
export type ReachLinkIn = z.infer<typeof ReachLinkInSchema>;

/** A computer, phone or browser this sandbox's agents reach through a card of its own. */
export const ReachDeviceSchema = z.object({
    card: z.string(),
    kind: z.string().describe("computer, phone or browser."),
    label: z.string().describe("What the owner calls it."),
    machineId: z.string().optional().describe("The computer's own stable id, shared by every environment on it: the join key across sandboxes."),
    hostname: z.string().optional().describe("Its OS host name, the join key when it has said no machine id."),
    platform: z.string().optional().describe("windows, macos, linux, android, ios."),
    online: z.boolean().optional().describe("Connected now; absent where nothing could say."),
    grants: z.array(z.string()).describe("The card's switches that are on (REACH_DEVICE_GRANTS)."),
    yours: yoursField,
    others: othersField,
});
export type ReachDevice = z.infer<typeof ReachDeviceSchema>;

/** A server this sandbox's agents sign in to over SSH. */
export const ReachServerSchema = z.object({
    card: z.string(),
    host: z.string().describe("The host it dials, lowercased: the join key across sandboxes."),
    user: z.string().optional(),
    admin: z.boolean().describe("The card holds an admin password its agents may type to sudo or su."),
    yours: yoursField,
    others: othersField,
});
export type ReachServer = z.infer<typeof ReachServerSchema>;

export const SandboxReachSchema = z.object({
    self: z.object({
        sandboxId: z.string().optional().describe("This sandbox's platform id, as its last announce was answered; absent before one."),
        runsOn: z
            .object({ host: z.string().optional(), os: z.string().optional() })
            .optional()
            .describe("The machine this copy runs on and its side, as its host named them. Only for the owner and Full access."),
        org: z
            .object({ id: z.string(), name: z.string() })
            .optional()
            .describe("The organisation whose policy this daemon enforces here; absent for a personal sandbox."),
    }),
    reader: z.object({
        tier: MemberTierSchema.describe("The reader's tier here, as this daemon enforces it now."),
        agents: z.boolean().describe("Whether the reader's conversations here run agents."),
    }),
    linksOut: z.array(ReachLinkOutSchema),
    linksIn: z.array(ReachLinkInSchema).optional().describe("Absent below Full access: minting and reading inbound links is theirs."),
    devices: z.array(ReachDeviceSchema),
    servers: z.array(ReachServerSchema),
    fleet: z
        .object({ yours: yoursField, others: othersField })
        .optional()
        .describe("This sandbox holds a fleet card: its agents may create and manage sandboxes on its owner's account."),
    people: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe("How many other people may sign in here, the owner included when the reader is not them. Absent when the roster is not the reader's to read."),
    readAt: z.number().describe("When this answer was put together, epoch milliseconds."),
});
export type SandboxReach = z.infer<typeof SandboxReachSchema>;

/** The host name of an address, lowercased, with no scheme, port, path or credentials: the join key two answers share. */
export const reachHostOf = (address: string): string =>
    address
        .trim()
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
        .replace(/^[^@/]*@/, "")
        .replace(/[/:?#].*$/, "");
