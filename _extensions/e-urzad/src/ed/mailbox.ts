import { createHash } from "node:crypto";
import type { z } from "zod";
import { type AccessToken, endpoint, type Fetch, jsonInit, parseJson, request } from "../core/http.js";
import { type JsonObject, type JsonValue, JsonValueSchema } from "../core/json.js";
import { type EdSettings, systemToken } from "./system-login.js";
import { EvidencesSchema, evidenceService, MessageListSchema, MessagesSchema, PendingSchema, SendAnswerSchema, TaskStatusSchema, type UaEvidence, type UaMessage } from "./mailbox-schemas.js";

// e-Doręczenia for one registered system (one card): UA API v3 for the mailbox, SE API v4 for the address register
// (BAE). Paths are the published OpenAPI documents'. Two reads have legal weight and are not plain reads here: fetching a
// message in `full`/`fullExtended` marks it opened and, for a notice (Stub), makes it delivered; that is `open`, which
// only the guard calls. Listing with format=metadata does neither.

const PAGE = 100;
const MAX_MESSAGES = 5000;

export interface MessageFile {
    readonly name: string;
    readonly contentType: string;
    readonly bytes: Uint8Array;
}

export type OpenResult = { readonly pending: true; readonly status: string } | { readonly pending: false; readonly message: UaMessage };

export interface Downloaded {
    readonly bytes: Uint8Array;
    readonly contentType: string;
}

export interface OutgoingMessage {
    // The UA Message object as prepared (messageMetadata, textBody), without attachments.
    readonly message: JsonObject;
    readonly files: readonly MessageFile[];
}

const fileId = (bytes: Uint8Array): string => {
    const hex = createHash("sha256").update(bytes).digest("hex").toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

export class EdClient {
    private token: AccessToken | undefined;

    constructor(
        readonly settings: EdSettings,
        private readonly fetcher: Fetch = fetch,
        private readonly clock: () => Date = () => new Date(),
    ) {}

    private async headers(extra: Readonly<Record<string, string>> = {}): Promise<Record<string, string>> {
        const now = this.clock();
        if (this.token === undefined || this.token.expiresAt <= now.getTime()) {
            this.token = await systemToken(this.settings, this.fetcher, now);
        }
        return { ...extra, authorization: `Bearer ${this.token.value}` };
    }

    private ua(segments: readonly string[], query?: Readonly<Record<string, string | undefined>>): string {
        return endpoint(this.settings.uaUrl, [this.settings.ade, ...segments], query);
    }

    private async getJson<T>(url: string, schema: z.ZodType<T>, what: string): Promise<T> {
        return parseJson(await request(this.fetcher, url, { headers: await this.headers({ accept: "application/json" }) }), schema, what);
    }

    // GET /{ade}/messages, format=metadata (which opens nothing), walked by offset/limit until the total.
    async inbox(limit = 500, label = "INBOX"): Promise<UaMessage[]> {
        const messages: UaMessage[] = [];
        for (let offset = 0; messages.length < Math.min(limit, MAX_MESSAGES); offset += PAGE) {
            const page = await this.getJson(this.ua(["messages"], { offset: String(offset), limit: String(PAGE), format: "metadata", label }), MessagesSchema, "e-Doręczenia inbox");
            messages.push(...page.messages);
            if (page.messages.length < PAGE || (page.total !== undefined && page.total !== null && offset + PAGE >= page.total)) {
                break;
            }
        }
        return messages.slice(0, limit);
    }

    // One message's metadata: who, what, when, status. Does not open it.
    async metadata(messageId: string): Promise<UaMessage | undefined> {
        const list = await this.getJson(this.ua(["messages", messageId], { format: "metadata" }), MessageListSchema, "e-Doręczenia message");
        return list[0];
    }

    // GET /{ade}/messages/{id}?format=fullExtended: content and attachments. Marks the message opened, and for a notice
    // (Stub) the operator then issues the receipt evidence (E.1): a legal act, which is why only the guard calls this.
    // 202 means the notice is still being turned into the message; the caller asks again later.
    async open(messageId: string): Promise<OpenResult> {
        const response = await request(this.fetcher, this.ua(["messages", messageId], { format: "fullExtended" }), { headers: await this.headers({ accept: "application/json" }) });
        if (response.status === 202) {
            const pending = await parseJson(response, PendingSchema, "e-Doręczenia message");
            return { pending: true, status: pending.status };
        }
        const [message] = await parseJson(response, MessageListSchema, "e-Doręczenia message");
        if (message === undefined) {
            throw new Error(`e-Doręczenia returned no message ${messageId}`);
        }
        return { pending: false, message };
    }

    // POST /{ade}/attachments/download: the attachment's bytes as a file, for one too large to arrive inline.
    async attachment(messageId: string, attachmentId: string): Promise<Downloaded> {
        const response = await request(this.fetcher, this.ua(["attachments", "download"]), jsonInit("POST", { messageId, attachmentId }, await this.headers({ accept: "application/octet-stream" })));
        return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
    }

    async evidences(messageId: string): Promise<UaEvidence[]> {
        const answer = await this.getJson(this.ua(["messages", messageId, "evidences"]), EvidencesSchema, "e-Doręczenia evidences");
        return answer.evidences ?? [];
    }

    // GET /{ade}/evidences/{purde|puh}/{evidenceId}: the evidence document itself (signed XML, or PDF for some types).
    async evidenceFile(evidence: Pick<UaEvidence, "evidenceId" | "type">): Promise<Downloaded> {
        const response = await request(this.fetcher, this.ua(["evidences", evidenceService(evidence.type), evidence.evidenceId]), { headers: await this.headers() });
        return { bytes: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") ?? "application/octet-stream" };
    }

    // POST {SE}/search/bae_search. The sender is always this mailbox (SE refuses any other); the rest is the caller's.
    async searchAddresses(query: JsonObject): Promise<JsonValue> {
        const body = { recipientEdasOnly: false, ...query, senderEda: this.settings.ade };
        const response = await request(this.fetcher, endpoint(this.settings.seUrl, ["search", "bae_search"]), jsonInit("POST", body, await this.headers({ accept: "application/json" })));
        return parseJson(response, JsonValueSchema, "BAE search");
    }

    async taskStatus(taskId: string): Promise<{ readonly status: string; readonly recipients: JsonValue }> {
        const status = await this.getJson(this.ua(["messages", "tasks", taskId, "status"]), TaskStatusSchema, "e-Doręczenia send task");
        const recipients = await this.getJson(this.ua(["messages", "tasks", taskId]), JsonValueSchema, "e-Doręczenia send task");
        return { status: status.messageTaskStatus, recipients };
    }

    async test(): Promise<{ readonly environment: string; readonly mailbox: string; readonly inbox: number }> {
        const page = await this.getJson(this.ua(["messages"], { offset: "0", limit: "1", format: "minimal", label: "INBOX" }), MessagesSchema, "e-Doręczenia inbox");
        return { environment: this.settings.environment, mailbox: this.settings.ade, inbox: page.total ?? page.messages.length };
    }

    // POST /{ade}/messages: only the guard calls it. Attachments go inline as Base64 FileData (the UA API technical
    // design's JSON upload); fileId is derived from the bytes so an approved message is reproducible.
    async send(outgoing: OutgoingMessage): Promise<{ readonly messageTaskId: string; readonly warning?: string | undefined }> {
        const attachments = outgoing.files.map((file, index) => ({
            order: index + 1,
            file: { fileMetadata: { fileId: fileId(file.bytes), filename: file.name, contentType: file.contentType, size: file.bytes.byteLength }, file: Buffer.from(file.bytes).toString("base64") },
        }));
        const body: JsonObject = { ...outgoing.message, attachments };
        const response = await request(this.fetcher, this.ua(["messages"]), jsonInit("POST", body, await this.headers({ accept: "application/json" })));
        return parseJson(response, SendAnswerSchema, "e-Doręczenia send");
    }
}
