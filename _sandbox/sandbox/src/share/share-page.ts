import type { SharePayload } from "@intentic/sandbox-contract";
import { escapeHtml } from "../panels/interstitial.js";

/* THE PAGE, AS TEXT — the built template with one conversation written into it.
 *
 * Its own module, and pure, because this is the step where a mistake is an injection: the payload is the
 * agent's and the user's own words, so everything in it is attacker-influenced in the only sense that matters
 * (a prompt can contain any characters at all, and often does — this product's conversations are full of HTML,
 * script tags and JSON).
 *
 * Two rules make that safe, and both are about the ONE place the data lands. It goes inside a
 * `<script type="application/json">` block, whose contents the HTML parser does not treat as markup at all —
 * with exactly one exception: the parser ends the block at the first `</script` (and, in a legacy corner, gets
 * confused by `<!--`). So every `<` in the serialized JSON is escaped to `<`, which JSON.parse turns back
 * into `<` and the HTML parser cannot read as anything. That single substitution retires the whole class:
 * there is no way to close the block, so there is no way to reach the document.
 *
 * The title is different — it lands in real markup, so it takes ordinary HTML escaping. */

// Marks the block the payload replaces. Matched as a literal, so a template that stops carrying it fails
// loudly at share time rather than publishing a page that renders nothing.
const DATA_OPEN = `<script id="intentic-conversation" type="application/json">`;
const DATA_CLOSE = `</script>`;
const TITLE = /<title>[^<]*<\/title>/;

export const encodePayload = (payload: SharePayload): string => JSON.stringify(payload).replaceAll("<", "\\u003c");

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
    // The tab's name, the text a link preview shows, and what a bookmark is filed under. Worth the one
    // substitution: "Shared conversation" on every tab is how a person loses the link they were sent.
    return withData.replace(TITLE, `<title>${escapeHtml(payload.title)}</title>`);
};
