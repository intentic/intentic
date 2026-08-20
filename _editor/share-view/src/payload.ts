import { type SharePayload, SharePayloadSchema } from "@intentic/sandbox-contract";

/* THE CONVERSATION THIS PAGE WAS BUILT AROUND, read out of the page itself.
 *
 * The daemon writes it into the `<script type="application/json">` block in index.html, so by the time this
 * module runs it is already in the document, there is no load state to render, no request that can fail, and
 * nothing this page needs a network for. A recipient opening the link a month later, from a sandbox that has
 * been off since, sees exactly what was shared.
 *
 * Parsed through the SAME schema the daemon wrote it with, and a page that fails to parse says so rather than
 * rendering half a conversation: the two ends of this are versioned together (both ship in one sandbox image),
 * so a mismatch means the file was edited or truncated, and neither is something to paper over. */

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
    // An unfilled copy of the template carries a literal `null`, a page that was built but never written to,
    // which is a different sentence than a corrupt one.
    if (parsed === null) {
        return { ok: false, reason: `Nothing has been shared to this address.` };
    }
    const result = SharePayloadSchema.safeParse(parsed);
    return result.success ? { ok: true, payload: result.data } : { ok: false, reason: `This page's conversation could not be read.` };
};
