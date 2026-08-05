/* The one bit of markup a capability guide's prose carries: `backticks` mark the literals the reader has to
 * find or type — a scope name, a menu item, a host, a command, a port. Everything around them is prose.
 *
 * It is authored rather than detected. A pattern-matcher over the same sentences has to decide whether "repo"
 * is a GitHub scope or an English word, whether "Contents" is a permission or a noun, and whether the full stop
 * after `host.docker.internal` belongs to the host or to the sentence — and it gets each of those wrong
 * somewhere in the catalog. Whoever wrote the sentence already knows.
 */
export interface GuidePart {
    readonly text: string;
    readonly literal: boolean;
}

// A capturing split alternates prose and capture, so the odd indices are exactly the backticked runs. An
// unpaired backtick matches nothing and stays in the prose it was typed in.
export const guideParts = (line: string): readonly GuidePart[] =>
    line
        .split(/`([^`]+)`/g)
        .map((text, index) => ({ text, literal: index % 2 === 1 }))
        .filter((part) => part.text !== ``);
