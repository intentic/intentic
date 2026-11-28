import { createHash } from "node:crypto";
import { join } from "node:path";
import { parseJsonOr } from "@intentic/base/json";
import { type ReceivedDrop, ReceivedDropSchema } from "@intentic/sandbox-contract/schemas/account-routes";
import { type Filed, type LegacySender, type NewMessage, s2sThreadsDocument, type StoredFile, type ThreadsStore, type Where } from "../../s2s/messages/threads-store.js";
import { defineStep } from "../../store/evolution/state-steps.js";

/* A DROP AS A MESSAGE, received the old way (docs/architecture/account-routing.md, "A drop"; docs/architecture/messages.md,
 * "Across versions"): a sandbox whose build still drops through `POST /account/drop` has no key, so it is no contact. Its
 * drops are filed as messages all the same, into one thread per (sending sandbox, person) that names the sender itself
 * (threads-store.ts LegacySender), shown on the Messages tab to that person and to maintainers, as the drops were. A drop's
 * message id is derived from the drop's own id, so a retry of one drop, or moving it twice, files it once. Nothing goes
 * back over such a thread: an answer goes the old way, `sandboxes send`, as a drop.
 *
 * The drops that waited in `account-inbox/` when this build came are moved into those threads once, at boot
 * (dropsIntoThreadsStep): their manifests become messages, their files move under `s2s-files/` as they are. */

// The wire id of the one thread each old sender drops into.
const LEGACY_WIRE = "drops";
const MANIFEST = "drop.json";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The thread's contact id for drops from one sandbox as one person. */
const legacyContactOf = (sandboxId: string, person: string): string => `legacy-${digest(`${sandboxId}\u0000${person.toLowerCase()}`).slice(0, 20)}`;

/** The message id a drop is filed under: UUIDv7-shaped (as every message id is), from the drop's id alone. */
export const legacyMessageIdOf = (dropId: string): string => {
    const hex = digest(`drop\u0000${dropId}`);
    const variant = (8 + (Number.parseInt(hex.charAt(16), 16) % 4)).toString(16);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const senderOf = (drop: ReceivedDrop): LegacySender => ({ sandboxId: drop.from.sandboxId, sandboxName: drop.from.sandboxName.slice(0, 120), person: drop.person });

const whereOf = (drop: ReceivedDrop): Where => ({ contact: legacyContactOf(drop.from.sandboxId, drop.person), wire: LEGACY_WIRE, legacy: senderOf(drop) });

const messageOf = (drop: ReceivedDrop): NewMessage => ({
    id: legacyMessageIdOf(drop.id),
    direction: "in",
    kind: "message",
    text: drop.note ?? "",
    attachments: drop.files.map((file) => ({ name: file.name, size: file.size })),
    as: drop.person,
    sentAt: drop.receivedAt,
    receivedAt: drop.receivedAt,
    read: false,
});

/** Files a drop that came through the account door as a message in its sender's thread. */
export const fileLegacyDrop = async (threads: Pick<ThreadsStore, "file">, drop: ReceivedDrop, files: readonly StoredFile[]): Promise<Filed & { readonly message: string }> => {
    const message = messageOf(drop);
    return { ...(await threads.file(whereOf(drop), message, files)), message: message.id };
};

type ThreadBody = typeof s2sThreadsDocument.schema._output;

// The threads already there for old senders, by contact, as the step finds them.
const legacyThreads = async (threadsRoot: string, list: (dir: string) => Promise<string[]>, read: (path: string) => Promise<string | undefined>) => {
    const held = new Map<string, { readonly id: string; readonly body: ThreadBody }>();
    for (const name of (await list(threadsRoot)).filter((each) => each.endsWith(".json"))) {
        const parsed = s2sThreadsDocument.schema.safeParse(parseJsonOr((await read(join(threadsRoot, name))) ?? "", undefined));
        if (parsed.success && parsed.data.legacy !== undefined && parsed.data.wire === LEGACY_WIRE) {
            held.set(parsed.data.contact, { id: name.slice(0, -".json".length), body: parsed.data });
        }
    }
    return held;
};

// One old sender's thread with its drops added; each drop once.
const threadWith = (held: ThreadBody | undefined, drops: readonly ReceivedDrop[]): ThreadBody => {
    const [first] = drops;
    if (first === undefined) {
        throw new Error("a thread is made for at least one drop");
    }
    const added = drops.map(messageOf);
    const ids = new Set(added.map((message) => message.id));
    const messages = [...(held?.messages ?? []).filter((message) => !ids.has(message.id)), ...added].toSorted((a, b) => a.sentAt - b.sentAt);
    const latest = drops.reduce((newest, drop) => (drop.receivedAt > newest.receivedAt ? drop : newest), first);
    return { ...held, contact: whereOf(first).contact, wire: LEGACY_WIRE, messages, createdAt: held?.createdAt ?? messages[0]?.sentAt ?? first.receivedAt, legacy: senderOf(latest) };
};

// Moves every drop waiting in `account-inbox/` into its sender's thread: the manifest becomes a message and goes, the files
// move under `s2s-files/<message>/` as they are (renamed, so a rollback puts them back). Settles once no manifest waits.
export const dropsIntoThreadsStep = defineStep({
    id: "account-inbox-into-threads",
    describe: "moves the drops waiting in the account inbox into the Messages tab's threads",
    plan: async ({ roots, kind, list, read }) => {
        // Spelled where it is joined, as every /history path is, so the state table's coverage test sees it built.
        const inboxRoot = join(roots.history, "account-inbox");
        const drops: ReceivedDrop[] = [];
        for (const name of await list(inboxRoot)) {
            const parsed = ReceivedDropSchema.safeParse(parseJsonOr((await read(join(inboxRoot, name, MANIFEST))) ?? "", undefined));
            if (parsed.success && parsed.data.id === name) {
                drops.push(parsed.data);
            }
        }
        if (drops.length === 0) {
            return undefined;
        }
        const threadsRoot = join(roots.history, s2sThreadsDocument.path);
        const held = await legacyThreads(threadsRoot, list, read);
        const bySender = Map.groupBy(drops, (drop) => whereOf(drop).contact);
        const writes = new Map<string, string | undefined>();
        const renames = new Map<string, string>();
        for (const [contact, theirs] of bySender) {
            const thread = held.get(contact);
            const id = thread?.id ?? `t-${digest(`legacy-thread\u0000${contact}`).slice(0, 32)}`;
            writes.set(join(threadsRoot, `${id}.json`), `${JSON.stringify(threadWith(thread?.body, theirs), undefined, 2)}\n`);
        }
        for (const drop of drops) {
            const files = join(inboxRoot, drop.id, "files");
            const target = join(roots.history, "s2s-files", legacyMessageIdOf(drop.id));
            if (drop.files.length > 0 && (await kind(files)) === "directory" && (await kind(target)) === undefined) {
                renames.set(files, target);
            }
            writes.set(join(inboxRoot, drop.id, MANIFEST), undefined);
        }
        return { changes: [`moves ${drops.length} drop(s) from account-inbox/ into ${bySender.size} Messages thread(s)`], writes, renames };
    },
});
