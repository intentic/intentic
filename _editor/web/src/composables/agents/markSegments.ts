/* Split a line into alternating plain / hit runs, so a template can mark the term without v-html — this text
 * is a chat's own words (a prompt, a title, a reply), none of which is trusted markup.
 *
 * Every occurrence, not just the first: a snippet is windowed around one hit but usually catches its
 * neighbours, and marking one of three identical words reads as a rendering bug. Returns a single plain run
 * when there is nothing to mark, which is also what the unfiltered case renders.
 *
 * A LEAF of its own rather than a member of useAgentFilter, which is what it grew out of: every card that
 * marks a term (the board's, the rail's, the evidence line) would otherwise pull the filter — and through it
 * the chat store, the sandbox client and the app's environment — in to reach one pure string function.
 *
 * `matchCase` is the field's Aa switch, and the marks obey it for the same reason the results do: with the
 * switch on, highlighting a lowercase twin of the term would show as a match the filter did not actually make.
 * The needle arrives folded the same way the filter folded it — lowercased by default, verbatim under Aa.
 */
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
