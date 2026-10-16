import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { proposeOpen, proposeSend } from "../actions.js";
import { edFromEnv, pickCard } from "../core/cards.js";
import { ActionGuard } from "../core/guard.js";
import { type JsonObject, parseJsonObject } from "../core/json.js";
import { OfficeRecords } from "../core/records.js";
import { EdClient } from "../ed/mailbox.js";
import { deliveryRow } from "../ed/mailbox-schemas.js";
import { saveProofs, syncInbox } from "../ed/deliveries.js";
import { type Context, pathArgument, print, printHeld, required, UsageError } from "./context.js";

// `e-urzad ed …`: e-Doręczenia for the connected system card. Listing and metadata open nothing; `open` is held,
// because opening a delivery is an act with legal effect; `send` is held.

export const ED_USAGE = `e-urzad ed <command> [--card <id>]
  test                                  sign in with the system certificate and read the inbox count
  sync                                  save the inbox list (metadata only) for the rail view
  inbox [--limit N]                     received messages, metadata only: opens nothing
  message <messageId>                   one message's metadata: opens nothing
  open <messageId>                      HELD (edoreczenia.delivery.open): fetch content + attachments into the records;
                                        marks it opened and, for a notice, makes it delivered (E.1)
  attachment <messageId> <attachmentId> save one attachment of an opened message
  evidences <messageId>                 the evidence list (A.1, E.1, BP.OX, …)
  proofs <messageId> [evidenceId]       save evidence documents as proofs beside the delivery
  search (--nip X | --regon X | --krs X | --pesel X | --ade X | --query <file.json>)
                                        the address register (BAE) through SE API v4
  send <message.json> [--file <path>]...
                                        HELD (edoreczenia.delivery.send): a UA Message, attachments as files
  task <messageTaskId>                  what became of a send`;

const OPTIONS = {
    card: { type: "string" },
    limit: { type: "string" },
    nip: { type: "string" },
    regon: { type: "string" },
    krs: { type: "string" },
    pesel: { type: "string" },
    ade: { type: "string" },
    query: { type: "string" },
    file: { type: "string", multiple: true },
} as const;

type SearchFlags = Readonly<Partial<Record<"nip" | "regon" | "krs" | "pesel" | "ade" | "query", string>>>;

// SE v4 bae_search bodies (se-api_v.4.0.5): official ids in mode 1, explicit ADEs in mode 2.
const searchQuery = async (flags: SearchFlags): Promise<JsonObject> => {
    if (flags.query !== undefined) {
        return parseJsonObject(await readFile(pathArgument(flags.query), "utf8"), "the query file");
    }
    if (flags.ade !== undefined) {
        return { recipientEdasOnly: true, recipientEdas: [flags.ade] };
    }
    const ids = (["nip", "regon", "krs", "pesel"] as const).flatMap((registry) => {
        const id = flags[registry];
        return id === undefined ? [] : [{ id, referenceRegistry: registry }];
    });
    if (ids.length === 0) {
        throw new UsageError("search by --nip, --regon, --krs, --pesel, --ade or a --query file");
    }
    return { recipientEdasOnly: false, officialIds: ids };
};

export const runEd = async (context: Context, argv: readonly string[]): Promise<void> => {
    const { values, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    const [command, ...rest] = positionals;
    if (command === undefined || command === "help") {
        context.out(`${ED_USAGE}\n`);
        return;
    }
    const card = pickCard(context.env, "e-doreczenia", values.card);
    const settings = edFromEnv(context.env, card);
    const client = new EdClient(settings);
    const records = new OfficeRecords(context.root, card, "e-doreczenia");
    const guard = new ActionGuard(context.root);
    switch (command) {
        case "test":
            print(context, { connected: true, card, ...(await client.test()), checked: "certificate and key, IAM sign-in and one inbox read" });
            return;
        case "sync": {
            const rows = await syncInbox(client, records);
            print(context, { card, deliveries: rows.length, saved: records.directory });
            return;
        }
        case "inbox": {
            const rows = (await client.inbox(Number.parseInt(values.limit ?? "100", 10) || 100)).flatMap((message) => deliveryRow(message) ?? []);
            print(context, rows);
            return;
        }
        case "message":
            print(context, await client.metadata(required(rest[0], "the message id")));
            return;
        case "open": {
            const messageId = required(rest[0], "the message id");
            const known = (await client.metadata(messageId).catch((cause: unknown) => {
                context.out(`note: the message's metadata could not be read first (${cause instanceof Error ? cause.message : "error"})\n`);
                return undefined;
            })) ?? undefined;
            const proposal = proposeOpen(settings, messageId, known === undefined ? undefined : deliveryRow(known));
            printHeld(context, await guard.propose(proposal));
            return;
        }
        case "attachment": {
            const messageId = required(rest[0], "the message id");
            const attachmentId = required(rest[1], "the attachment id");
            const file = await client.attachment(messageId, attachmentId);
            print(context, await records.save(["deliveries", messageId], attachmentId, file.bytes));
            return;
        }
        case "evidences":
            print(context, await client.evidences(required(rest[0], "the message id")));
            return;
        case "proofs":
            print(context, await saveProofs(client, records, required(rest[0], "the message id"), rest[1]));
            return;
        case "search":
            print(context, await client.searchAddresses(await searchQuery(values)));
            return;
        case "send": {
            const message = parseJsonObject(await readFile(pathArgument(required(rest[0], "the message file")), "utf8"), "the message file");
            const files = (values.file ?? []).map((path) => ({ path: pathArgument(path) }));
            printHeld(context, await guard.propose(proposeSend(settings, message, files)));
            return;
        }
        case "task": {
            const result = await client.taskStatus(required(rest[0], "the message task id"));
            print(context, { status: result.status, recipients: result.recipients });
            return;
        }
        default:
            throw new UsageError(`unknown ed command "${command}"\n${ED_USAGE}`);
    }
};
