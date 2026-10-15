import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { z } from "zod";
import { ACTION_KEYS, type Operation, type Proposal } from "./core/guard.js";
import { type JsonObject, JsonObjectSchema } from "./core/json.js";
import type { OfficeRecords } from "./core/records.js";
import type { DeliveryRow } from "./core/snapshot.js";
import type { EdSettings } from "./ed/system-login.js";
import type { EdClient } from "./ed/mailbox.js";
import { saveOpened } from "./ed/deliveries.js";
import type { EzdSettings } from "./ezd/key-exchange.js";
import type { EzdClient } from "./ezd/integrator.js";

// The office acts, each as a proposal the guard holds or runs (core/guard.ts) and as the one function that performs it
// once allowed. The proposal is what the owner reads on the approval card; `perform` is all that ever reaches the
// office, whether the rule said allow or the owner said yes.

export const ezdTarget = (settings: EzdSettings): string => `EZD RP ${new URL(settings.apiUrl).host} (podmiot ${settings.subjectId})`;
export const edTarget = (settings: EdSettings): string => `e-Doręczenia ${settings.environment} ${new URL(settings.uaUrl).host} as ${settings.ade}`;

const fence = (value: JsonObject): string => `\`\`\`json\n${JSON.stringify(value, undefined, 2)}\n\`\`\``;

export interface FileArgument {
    readonly path: string;
    readonly name?: string | undefined;
}

export const proposeAttach = (settings: EzdSettings, caseId: string, files: readonly FileArgument[]): Proposal => {
    if (files.length === 0) {
        throw new Error("name at least one file to add to the case");
    }
    return {
        key: ACTION_KEYS.attachToCase,
        card: settings.card,
        target: ezdTarget(settings),
        summary: `EZD RP: add ${files.length} file(s) to case ${caseId}`,
        details: `Adds these files as documents in EZD RP case **${caseId}** (POST /sprawy/{id}/dokumenty). They become part of the case files; removing them later is a separate act in EZD.`,
        args: { caseId },
        files,
    };
};

export const proposeRegisterIncoming = (settings: EzdSettings, input: { readonly documentId?: string | undefined; readonly file?: FileArgument | undefined; readonly metadata?: JsonObject | undefined }): Proposal => {
    if ((input.documentId === undefined) === (input.file === undefined)) {
        throw new Error("register either an existing EZD document (its idDokumentPrzestrzeni) or a file, not both or neither");
    }
    const what = input.documentId === undefined ? `the attached file, uploaded as a new document task (POST /obiegi)` : `EZD document ${input.documentId}`;
    return {
        key: ACTION_KEYS.registerIncoming,
        card: settings.card,
        target: ezdTarget(settings),
        summary: `EZD RP: register incoming mail in the RPW register${input.documentId === undefined ? "" : ` (document ${input.documentId})`}`,
        details: `Registers ${what} in the incoming-mail register (RPW, POST /dokumenty/{id}/rpw), which gives it an RPW number: an entry in the office's official register.${input.metadata === undefined ? " No register metadata is filled in; the office completes it in EZD." : `\n\nThen fills in the register entry's metadata (PUT /rpw/{numer}/{rok}/metadane):\n\n${fence(input.metadata)}`}`,
        args: { documentId: input.documentId ?? null, metadata: input.metadata ?? null },
        files: input.file === undefined ? [] : [input.file],
    };
};

export const proposeRegisterOutgoing = (settings: EzdSettings, payload: JsonObject): Proposal => ({
    key: ACTION_KEYS.registerOutgoing,
    card: settings.card,
    target: ezdTarget(settings),
    summary: `EZD RP: register outgoing paper mail for case ${String(payload["znakSprawy"] ?? payload["idSprawa"] ?? "?")}`,
    details: `Creates a paper outgoing-mail record (korespondencja wychodząca, POST /kw/wyslanie) that the office's mailroom then dispatches. This is not an electronic delivery.\n\n${fence(payload)}`,
    args: { payload },
    files: [],
});

export const proposeOpen = (settings: EdSettings, messageId: string, known: DeliveryRow | undefined): Proposal => ({
    key: ACTION_KEYS.openDelivery,
    card: settings.card,
    target: edTarget(settings),
    summary: `e-Doręczenia: open delivery ${known?.subject === undefined || known.subject === "" ? messageId : `"${known.subject}"`}${known?.from === undefined || known.from === "" ? "" : ` from ${known.from}`}`,
    details: `Fetches the full content and attachments of message **${messageId}** (${settings.environment}, mailbox ${settings.ade}) and saves them in the workspace records. **Opening has legal effect:** the message is marked opened, and when it is a notice of a waiting delivery the operator issues the receipt evidence (E.1), which can start the office's deadlines. Status now: ${known?.status ?? "unknown"}${known?.kind === undefined ? "" : `, ${known.kind}`}${known?.daysToReceive === undefined ? "" : `, ${known.daysToReceive} day(s) left to collect`}.`,
    args: { messageId },
    files: [],
});

const MessageDraftSchema = z.looseObject({
    messageMetadata: z.looseObject({
        from: z.looseObject({ eDeliveryAddress: z.string() }),
        to: z.array(z.looseObject({ eDeliveryAddress: z.string().min(1) })).min(1).max(15),
        subject: z.string().min(1),
        shippingService: z.literal("electronic"),
    }),
    textBody: z.string().optional(),
});

export const proposeSend = (settings: EdSettings, message: JsonObject, files: readonly FileArgument[]): Proposal => {
    const parsed = MessageDraftSchema.safeParse(message);
    if (!parsed.success) {
        throw new Error(`the message is not a UA Message this command sends: ${z.prettifyError(parsed.error)}`);
    }
    const metadata = parsed.data.messageMetadata;
    if (metadata.from.eDeliveryAddress !== settings.ade) {
        throw new Error(`messageMetadata.from must be this card's mailbox ${settings.ade}, not ${metadata.from.eDeliveryAddress}`);
    }
    if ("attachments" in message) {
        throw new Error("give attachments as files (--file), not inside the message JSON");
    }
    const recipients = metadata.to.map((entry) => entry.eDeliveryAddress).join(", ");
    return {
        key: ACTION_KEYS.sendDelivery,
        card: settings.card,
        target: edTarget(settings),
        summary: `e-Doręczenia ${settings.environment}: send "${metadata.subject}" to ${recipients}`,
        details: `Sends a registered electronic delivery from **${settings.ade}** to **${recipients}** (POST /{ade}/messages, ${settings.environment}). A delivery has legal effect for the recipient and cannot be recalled. The send answer is only a task id: delivery is proven by the evidence (A.1, E.1) the operator issues later.\n\n**Subject:** ${metadata.subject}\n\n**Text:**\n\n${parsed.data.textBody ?? "(none)"}`,
        args: { message },
        files,
    };
};

const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
    [".pdf", "application/pdf"],
    [".xml", "application/xml"],
    [".xades", "application/xml"],
    [".txt", "text/plain"],
    [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    [".odt", "application/vnd.oasis.opendocument.text"],
    [".jpg", "image/jpeg"],
    [".png", "image/png"],
    [".zip", "application/zip"],
]);

const filesOf = (operation: Operation): Promise<{ readonly name: string; readonly bytes: Uint8Array; readonly contentType: string }[]> =>
    Promise.all(operation.files.map(async (file) => ({ name: file.name, bytes: new Uint8Array(await readFile(file.path)), contentType: CONTENT_TYPES.get(extname(file.name).toLowerCase()) ?? "application/octet-stream" })));

const OptionalText = z.string().nullish().transform((value) => value ?? undefined);

export interface Clients {
    readonly ezd?: EzdClient | undefined;
    readonly ed?: EdClient | undefined;
}

const need = <T>(client: T | undefined, service: string): T => {
    if (client === undefined) {
        throw new Error(`this operation needs the ${service} card`);
    }
    return client;
};

// The only code that acts on an office. Answers what the office answered, as plain JSON.
export const perform = async (operation: Operation, clients: Clients, records: OfficeRecords): Promise<JsonObject> => {
    const args = operation.args;
    const files = await filesOf(operation);
    switch (operation.key) {
        case ACTION_KEYS.attachToCase:
            return need(clients.ezd, "EZD RP").attachToCase(z.string().parse(args["caseId"]), files);
        case ACTION_KEYS.registerIncoming:
            return need(clients.ezd, "EZD RP").registerIncoming({
                documentId: OptionalText.parse(args["documentId"]),
                file: files[0],
                metadata: args["metadata"] === null || args["metadata"] === undefined ? undefined : JsonObjectSchema.parse(args["metadata"]),
            });
        case ACTION_KEYS.registerOutgoing:
            return need(clients.ezd, "EZD RP").registerOutgoing(JsonObjectSchema.parse(args["payload"]));
        case ACTION_KEYS.openDelivery: {
            const client = need(clients.ed, "e-Doręczenia");
            const messageId = z.string().parse(args["messageId"]);
            const opened = await client.open(messageId);
            if (opened.pending) {
                return { messageId, pending: opened.status, next: "the operator is still preparing the delivery; run the same approval again in a few seconds" };
            }
            const saved = await saveOpened(client, records, messageId, opened.message);
            return JsonObjectSchema.parse(JSON.parse(JSON.stringify(saved)));
        }
        case ACTION_KEYS.sendDelivery: {
            const answer = await need(clients.ed, "e-Doręczenia").send({ message: JsonObjectSchema.parse(args["message"]), files });
            return { messageTaskId: answer.messageTaskId, warning: answer.warning ?? null, next: `check delivery with: e-urzad ed task ${answer.messageTaskId}; save its proofs once the evidence arrives` };
        }
        default:
            throw new Error(`unknown office action ${String(operation.key)}`);
    }
};
