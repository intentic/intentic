// Splits text into plain/hit runs for highlighting without v-html, since the source text is untrusted. Marks every
// occurrence, not just the first, and folds case the same way the filter does unless matchCase is set.
export const markSegments = (text: string, needle: string, matchCase = false): readonly { text: string; hit: boolean }[] => {
    if (needle.length === 0) {
        return [{ text, hit: false }];
    }
    const haystack = matchCase ? text : text.toLowerCase();
    const out: { text: string; hit: boolean }[] = [];
    let at = 0;
    for (;;) {
        const found = haystack.indexOf(needle, at);
        if (found === -1) {
            break;
        }
        if (found > at) {
            out.push({ text: text.slice(at, found), hit: false });
        }
        out.push({ text: text.slice(found, found + needle.length), hit: true });
        at = found + needle.length;
    }
    if (at < text.length) {
        out.push({ text: text.slice(at), hit: false });
    }
    return out.length === 0 ? [{ text, hit: false }] : out;
};
