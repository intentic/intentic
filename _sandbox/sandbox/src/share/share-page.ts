import type { SharePayload } from "@intentic/sandbox-contract";
import { escapeHtml } from "../panels/interstitial.js";

// The payload is fully attacker-influenced: a prompt can contain any character, and conversations here are full of HTML
// and script tags. Every `<` in the JSON script block is written as a unicode escape, so the HTML parser can never find
// a closing `</script` to break out through; the title, in real markup, gets ordinary HTML escaping instead.

// Marks the block the payload replaces; a template missing it fails loudly rather than silently.
const DATA_OPEN = `<script id="intentic-conversation" type="application/json">`;
const DATA_CLOSE = `</script>`;
const TITLE = /<title>[^<]*<\/title>/;

const encodePayload = (payload: SharePayload): string => JSON.stringify(payload).replaceAll("<", "\\u003c");

export const sharePage = (template: string, payload: SharePayload): string => {
    const open = template.indexOf(DATA_OPEN);
    if (open === -1) {
        throw new Error("the shared-conversation template has no data block");
    }
    const start = open + DATA_OPEN.length;
    const end = template.indexOf(DATA_CLOSE, start);
    if (end === -1) {
        throw new Error("the shared-conversation template's data block is not closed");
    }
    const withData = `${template.slice(0, start)}${encodePayload(payload)}${template.slice(end)}`;
    // Tab name, link-preview text, and bookmark title; worth escaping so every tab isn't just "Shared conversation".
    return withData.replace(TITLE, `<title>${escapeHtml(payload.title)}</title>`);
};
