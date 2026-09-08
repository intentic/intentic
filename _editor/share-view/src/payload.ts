import { type SharePayload, SharePayloadSchema } from "@intentic/sandbox-contract";

// Reads the conversation the daemon embedded in index.html's `<script type="application/json">` block — already
// in the document, so nothing here needs a network or has a load state. Parsed through the same schema the daemon
// wrote it with; a mismatch means the file was edited or truncated.

export const ELEMENT_ID = "intentic-conversation";

export type PayloadResult = { readonly ok: true; readonly payload: SharePayload } | { readonly ok: false; readonly reason: string };

export const readPayload = (doc: Document = document): PayloadResult => {
    const element = doc.getElementById(ELEMENT_ID);
    if (element === null) {
        return { ok: false, reason: `This page is missing its conversation.` };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(element.textContent ?? "");
    } catch {
        return { ok: false, reason: `This page's conversation could not be read.` };
    }
    // A literal `null` means the template was never written to, not that it's corrupt.
    if (parsed === null) {
        return { ok: false, reason: `Nothing has been shared to this address.` };
    }
    const result = SharePayloadSchema.safeParse(parsed);
    return result.success ? { ok: true, payload: result.data } : { ok: false, reason: `This page's conversation could not be read.` };
};
