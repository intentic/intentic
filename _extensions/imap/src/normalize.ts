import type { ListenerMessage } from "@intentic/connector-runtime";

// Pure mapping from IMAP happenings to the daemon's normalized listener-message envelope (the contract's
// ListenerMessageSchema): provider "imap", type message/flags/expunge, channelId = the watched mailbox so a
// trigger's channelId filter selects a folder. Structural input slices (not imapflow's types) keep this module
// pure and directly fakeable in tests.

export interface MailAddress {
    readonly name?: string;
    readonly address?: string;
}

export interface MailEnvelope {
    readonly subject?: string;
    readonly messageId?: string;
    readonly from?: readonly MailAddress[];
    readonly to?: readonly MailAddress[];
    readonly cc?: readonly MailAddress[];
}

export interface MailPart {
    readonly type: string;
    readonly size?: number;
    readonly disposition?: string;
    readonly dispositionParameters?: Record<string, string>;
    readonly parameters?: Record<string, string>;
    readonly childNodes?: readonly MailPart[];
}

// Bounded excerpt: the wake carries the subject + enough body to triage; the agent fetches the full message
// over the imap skill (by extra.uid) when it needs more.
const EXCERPT_MAX = 4096;
export const excerptOf = (text: string): string => {
    const trimmed = text.trim();
    return trimmed.length <= EXCERPT_MAX ? trimmed : `${trimmed.slice(0, EXCERPT_MAX)}…`;
};

// Crude but dependency-free text of an HTML-only message (mailparser only derives `text` when a text part
// exists), tags and style/script bodies out, whitespace collapsed. Triage quality, not fidelity.
export const htmlText = (html: string): string =>
    html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

export interface MailAttachment {
    readonly filename: string;
    readonly contentType: string;
    readonly size?: number;
}

// Attachments come from the untruncated BODYSTRUCTURE, not from parsing the (size-capped) source, a large
// message's attachments must still be listed even when its MIME didn't fully arrive. Inline-with-filename
// parts (pasted images) count; unnamed body parts don't.
export const attachmentsOf = (part: MailPart): MailAttachment[] => {
    if (part.childNodes !== undefined) {
        return part.childNodes.flatMap(attachmentsOf);
    }
    const filename = part.dispositionParameters?.["filename"] ?? part.parameters?.["name"];
    if (part.disposition?.toLowerCase() !== "attachment" && filename === undefined) {
        return [];
    }
    return [{ filename: filename ?? "unnamed", contentType: part.type, ...(part.size !== undefined ? { size: part.size } : {}) }];
};

export interface MailMessageInput {
    readonly capabilityId: string;
    readonly username: string;
    readonly mailbox: string;
    readonly uidValidity: string;
    readonly uid: number;
    readonly envelope: MailEnvelope | undefined;
    readonly internalDate: Date | undefined;
    readonly bodyStructure: MailPart | undefined;
    readonly text: string | undefined;
}

export const mailMessage = (input: MailMessageInput): ListenerMessage => {
    const from = input.envelope?.from?.[0];
    const address = from?.address ?? "unknown";
    const subject = input.envelope?.subject ?? "(no subject)";
    const attachments = input.bodyStructure === undefined ? [] : attachmentsOf(input.bodyStructure);
    // "Addressed to me": the account address appears in To (not merely Cc), powers the trigger's `mentioned`
    // filter. Only meaningful when the login is an address; host-style logins never set it.
    const mentioned =
        input.username.includes("@") && input.envelope?.to?.some((entry) => entry.address?.toLowerCase() === input.username.toLowerCase()) === true;
    const to = (input.envelope?.to ?? []).flatMap((entry) => (entry.address === undefined ? [] : [entry.address]));
    const cc = (input.envelope?.cc ?? []).flatMap((entry) => (entry.address === undefined ? [] : [entry.address]));
    return {
        provider: "imap",
        type: "message",
        id: `${input.capabilityId}:${input.uidValidity}:${input.uid}`,
        channelId: input.mailbox,
        author: { id: address, name: from?.name === undefined || from.name === "" ? address : from.name },
        content: input.text === undefined || input.text === "" ? `Subject: ${subject}` : `Subject: ${subject}\n\n${excerptOf(input.text)}`,
        ...(mentioned ? { mentioned: true } : {}),
        timestamp: (input.internalDate ?? new Date()).toISOString(),
        extra: {
            capabilityId: input.capabilityId,
            uid: input.uid,
            ...(input.envelope?.messageId !== undefined ? { messageId: input.envelope.messageId } : {}),
            ...(to.length > 0 ? { to } : {}),
            ...(cc.length > 0 ? { cc } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
        },
    };
};

// Flags/expunge carry whatever the server actually reported, plain servers send only a sequence number, and
// no seq→uid map is kept (seq numbers shift after every expunge), so the payload never fabricates a uid.
// These events have no human author; the account stands in.

export interface FlagsMessageInput {
    readonly capabilityId: string;
    readonly username: string;
    readonly mailbox: string;
    readonly uidValidity: string;
    readonly seq: number;
    readonly uid: number | undefined;
    readonly flags: readonly string[];
}

export const flagsMessage = (input: FlagsMessageInput): ListenerMessage => ({
    provider: "imap",
    type: "flags",
    id: `${input.capabilityId}:${input.uidValidity}:flags:${input.uid ?? `seq${input.seq}`}:${Date.now()}`,
    channelId: input.mailbox,
    author: { id: input.username, name: input.username },
    content: `Flags changed on a message in ${input.mailbox} (${input.uid === undefined ? `seq ${input.seq}` : `uid ${input.uid}`}): ${input.flags.length === 0 ? "(none)" : input.flags.join(", ")}`,
    timestamp: new Date().toISOString(),
    extra: {
        capabilityId: input.capabilityId,
        seq: input.seq,
        ...(input.uid === undefined ? {} : { uid: input.uid }),
        flags: [...input.flags],
    },
});

export interface ExpungeMessageInput {
    readonly capabilityId: string;
    readonly username: string;
    readonly mailbox: string;
    readonly uidValidity: string;
    readonly seq: number | undefined;
    readonly uid: number | undefined;
    readonly vanished: boolean;
}

export const expungeMessage = (input: ExpungeMessageInput): ListenerMessage => ({
    provider: "imap",
    type: "expunge",
    id: `${input.capabilityId}:${input.uidValidity}:expunge:${input.uid ?? `seq${input.seq ?? 0}`}:${Date.now()}`,
    channelId: input.mailbox,
    author: { id: input.username, name: input.username },
    content: `A message was removed from ${input.mailbox} (${input.uid === undefined ? `seq ${input.seq ?? "unknown"}` : `uid ${input.uid}`})`,
    timestamp: new Date().toISOString(),
    extra: {
        capabilityId: input.capabilityId,
        ...(input.seq === undefined ? {} : { seq: input.seq }),
        ...(input.uid === undefined ? {} : { uid: input.uid }),
        vanished: input.vanished,
    },
});
