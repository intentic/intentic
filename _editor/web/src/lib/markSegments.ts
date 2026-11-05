// Splits text into plain/hit runs for highlighting without v-html, since the source text is untrusted. Marks every
// occurrence, not just the first, and folds case the same way the filter does unless matchCase is set. The text's own
// ends read as spaces, as the filter reads a line (agent-search.ts), so " fix" is lit at the start of a line it found.
export const markSegments = (text: string, needle: string, matchCase = false): readonly { text: string; hit: boolean }[] => {
    if (needle.length === 0) {
        return [{ text, hit: false }];
    }
    // Index `p` here is `p - 1` in `text`.
    const haystack = ` ${matchCase ? text : text.toLowerCase()} `;
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    let from = 0;
    for (;;) {
        const found = haystack.indexOf(needle, from);
        if (found === -1) {
            break;
        }
        from = found + needle.length;
        const start = Math.max(0, found - 1);
        const end = Math.min(text.length, found - 1 + needle.length);
        // Only the padding matched, nothing of the text itself to light.
        if (end <= start) {
            continue;
        }
        if (start > at) {
            out.push({ text: text.slice(at, start), hit: false });
        }
        out.push({ text: text.slice(start, end), hit: true });
        at = end;
    }
    if (at < text.length) {
        out.push({ text: text.slice(at), hit: false });
    }
    return out.length === 0 ? [{ text, hit: false }] : out;
};
