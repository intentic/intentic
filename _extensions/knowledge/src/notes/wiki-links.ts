export interface WikiLinkToken {
    readonly start: number;
    readonly end: number;
    readonly target: string;
    readonly label: string | undefined;
}

// `[[target]]` or `[[target|what to call it]]`, scanned once from left to right. Keeping the grammar here means
// indexing links and removing their markers from search snippets cannot drift or reintroduce regex backtracking.
export const wikiLinksIn = (text: string): readonly WikiLinkToken[] => {
    const links: WikiLinkToken[] = [];
    let cursor = 0;
    while (cursor < text.length) {
        const start = text.indexOf("[[", cursor);
        if (start === -1) {
            break;
        }
        const close = text.indexOf("]]", start + 2);
        if (close === -1) {
            break;
        }
        const value = text.slice(start + 2, close);
        const separator = value.indexOf("|");
        const target = separator === -1 ? value : value.slice(0, separator);
        const label = separator === -1 ? undefined : value.slice(separator + 1);
        if (target !== "" && !target.includes("[") && !target.includes("]") && label !== "" && !label?.includes("]")) {
            links.push({ start, end: close + 2, target, label });
        }
        cursor = close + 2;
    }
    return links;
};
