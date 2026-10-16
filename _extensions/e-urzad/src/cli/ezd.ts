import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { proposeAttach, proposeRegisterIncoming, proposeRegisterOutgoing } from "../actions.js";
import { ezdFromEnv, pickCard } from "../core/cards.js";
import { ActionGuard } from "../core/guard.js";
import { parseJsonObject } from "../core/json.js";
import { OfficeRecords } from "../core/records.js";
import { EzdClient } from "../ezd/integrator.js";
import { type CaseStatusName, CaseStatusNameSchema } from "../ezd/integrator-schemas.js";
import { saveDocument, syncCasesAndTasks } from "../ezd/sync.js";
import { type Context, pathArgument, print, printHeld, required, UsageError } from "./context.js";

// `e-urzad ezd …`: EZD RP for the connected card. Reads answer JSON; writes go through the guard and print the approval
// they were held under: once a person approves one, the sandbox carries it out itself (core/guard.ts).

export const EZD_USAGE = `e-urzad ezd <command> [--card <id>]
  test                                  exchange the API key and read the user and one task
  sync                                  save cases in progress and the position's tasks for the rail view
  cases [--status open|all|closed|suspended|postponed|resumed] [--sign S] [--jrwa J] [--title T] [--limit N]
  case <idSprawa> [--metadata] [--documents]
  documents --criteria <file.json>      POST /dokumenty/_search; EZD wants at least two criteria
  document <idDokumentPrzestrzeni> [--metadata] [--signatures]
  tasks [--limit N]                     the position's "Do obsłużenia" list
  download <idDokumentPrzestrzeni>      save the document's file into the records
  attach <idSprawa> <file>...           HELD (ezdrp.case.attach-draft): add files to a case
  register-incoming (--document <id> | --file <path>) [--rpw-metadata <file.json>]
                                        HELD (ezdrp.document.register-incoming): RPW registration
  register-outgoing <payload.json>      HELD (ezdrp.document.register-outgoing): paper outgoing mail (POST /kw/wyslanie)`;

const OPTIONS = {
    card: { type: "string" },
    status: { type: "string" },
    sign: { type: "string" },
    jrwa: { type: "string" },
    title: { type: "string" },
    limit: { type: "string" },
    metadata: { type: "boolean" },
    "rpw-metadata": { type: "string" },
    documents: { type: "boolean" },
    signatures: { type: "boolean" },
    criteria: { type: "string" },
    document: { type: "string" },
    file: { type: "string" },
} as const;

const limitOf = (value: string | undefined, fallback: number): number => {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const statusOf = (value: string | undefined): CaseStatusName => {
    const parsed = CaseStatusNameSchema.safeParse(value ?? "open");
    if (!parsed.success) {
        throw new UsageError(`--status must be one of ${CaseStatusNameSchema.options.join(", ")}`);
    }
    return parsed.data;
};

const readObject = async (path: string, what: string) => parseJsonObject(await readFile(pathArgument(path), "utf8"), what);

export const runEzd = async (context: Context, argv: readonly string[]): Promise<void> => {
    const { values, positionals } = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
    const [command, ...rest] = positionals;
    if (command === undefined || command === "help") {
        context.out(`${EZD_USAGE}\n`);
        return;
    }
    const card = pickCard(context.env, "ezd-rp", values.card);
    const settings = ezdFromEnv(context.env, card);
    const client = new EzdClient(settings);
    const records = new OfficeRecords(context.root, card, "ezd-rp");
    const guard = new ActionGuard(context.root);
    const limit = limitOf(values.limit, 100);
    switch (command) {
        case "test": {
            const result = await client.test();
            print(context, { connected: true, card, user: result.user, position: result.position, checked: "API-key exchange, user lookup and one read of the task list" });
            return;
        }
        case "sync": {
            const result = await syncCasesAndTasks(client, records);
            print(context, { card, cases: result.cases.length, tasks: result.tasks.length, saved: records.directory });
            return;
        }
        case "cases":
            print(context, await client.cases({ status: statusOf(values.status), sign: values.sign, jrwa: values.jrwa, title: values.title }, limit));
            return;
        case "case": {
            const id = required(rest[0], "the case id (idSprawa)");
            print(context, {
                case: await client.case(id),
                metadata: values.metadata === true ? await client.caseMetadata(id) : null,
                documents: values.documents === true ? await client.caseDocuments(id) : null,
            });
            return;
        }
        case "documents":
            print(context, await client.searchDocuments(await readObject(required(values.criteria, "--criteria <file.json>"), "the criteria file"), limit));
            return;
        case "document": {
            const id = required(rest[0], "the document id (idDokumentPrzestrzeni)");
            print(context, {
                document: await client.document(id),
                metadata: values.metadata === true ? await client.documentMetadata(id) : null,
                signatures: values.signatures === true ? await client.documentSignatures(id) : null,
            });
            return;
        }
        case "tasks":
            print(context, await client.tasks(limit));
            return;
        case "download":
            print(context, await saveDocument(client, records, required(rest[0], "the document id")));
            return;
        case "attach": {
            const files = rest.slice(1).map((path) => ({ path: pathArgument(path) }));
            printHeld(context, await guard.propose(proposeAttach(settings, required(rest[0], "the case id"), files)));
            return;
        }
        case "register-incoming": {
            const metadata = values["rpw-metadata"] === undefined ? undefined : await readObject(values["rpw-metadata"], "the RPW metadata file");
            const proposal = proposeRegisterIncoming(settings, { documentId: values.document, file: values.file === undefined ? undefined : { path: pathArgument(values.file) }, metadata });
            printHeld(context, await guard.propose(proposal));
            return;
        }
        case "register-outgoing": {
            const payload = await readObject(required(rest[0], "the payload file"), "the payload file");
            printHeld(context, await guard.propose(proposeRegisterOutgoing(settings, payload)));
            return;
        }
        default:
            throw new UsageError(`unknown ezd command "${command}"\n${EZD_USAGE}`);
    }
};
