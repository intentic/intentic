// What a stylesheet cannot decide about a markdown table, decided on the sanitized DOM: where a long token may
// break, and which columns are numeric. Runs on every parse, before the surface's own decorator (render.ts); the
// layout half of the same rules is prose.css.

// A break opportunity goes after each of these — never after a hyphen, which already breaks: one more break point
// there only lets a column starve narrower than it reads at.
const SEPARATOR = /(?<=[/\\_.:@=&?])(?=[^/\\_.:@=&?])/;

// Under this length a token cannot hold a column open on its own, so it stays whole.
const BREAKABLE = 16;

// A run this long with nowhere to break (a hash, a base64 blob) is one no column can place: prose.css lets that
// cell break anywhere. A SHORT run is a unit — a flag, a commit id — and holds its column open instead.
const UNPLACEABLE = 24;

// A number, including what an agent writes around one (sign, currency, percent, thousands). A version ("1.2.3"),
// a time ("20:42") or a date is deliberately not one: those columns read left.
const NUMERIC = /^[+-]?[$€£]?\d+(?:[.,]\d+)?%?$/;

// Placeholders that neither make a column numeric nor disqualify it.
const NEUTRAL = new Set([``, `-`, `–`, `—`, `·`, `n/a`]);

const TEXT_NODE = 3;

const textNodesIn = (node: Node, found: Text[]): Text[] => {
    for (const child of node.childNodes) {
        if (child.nodeType === TEXT_NODE) {
            found.push(child as Text);
        } else {
            textNodesIn(child, found);
        }
    }
    return found;
};

// Rewrites one text node so its long tokens carry break opportunities at their separators. `<wbr>` rather than a
// CSS rule because only the element carries WHERE: a path breaks after a slash, and copies back out unchanged.
const addBreaks = (node: Text): void => {
    const owner = node.ownerDocument;
    if (owner === null) {
        return;
    }
    const pieces: (string | null)[] = [];
    for (const token of node.data.split(/(\s+)/)) {
        const split = token.length < BREAKABLE ? [token] : token.split(SEPARATOR);
        split.forEach((piece, index) => {
            if (index > 0) {
                pieces.push(null);
            }
            pieces.push(piece);
        });
    }
    if (!pieces.includes(null)) {
        return;
    }
    const fragment = owner.createDocumentFragment();
    for (const piece of pieces) {
        fragment.append(piece === null ? owner.createElement(`wbr`) : piece);
    }
    node.replaceWith(fragment);
};

// A column reads right when every cell in it is a number, so the digits line up under each other (prose.css pairs
// this with tabular figures). Alignment the markdown wrote itself always wins.
const alignNumericColumns = (table: HTMLTableElement): void => {
    const header = table.tHead?.rows[0];
    if (header === undefined) {
        return;
    }
    const rows = [...table.tBodies].flatMap((body) => [...body.rows]);
    [...header.cells].forEach((head, index) => {
        if (head.hasAttribute(`align`)) {
            return;
        }
        const cells = rows.map((row) => row.cells[index]).filter((cell) => cell !== undefined);
        const texts = cells.map((cell) => (cell.textContent ?? ``).trim());
        if (!texts.some((text) => NUMERIC.test(text)) || !texts.every((text) => NUMERIC.test(text) || NEUTRAL.has(text.toLowerCase()))) {
            return;
        }
        for (const cell of [head, ...cells]) {
            cell.setAttribute(`align`, `right`);
        }
    });
};

// The longest run with nowhere to break in it — what the cell's column cannot be narrower than.
const longestRun = (text: string): number =>
    text
        .split(/\s+/)
        .flatMap((token) => token.split(SEPARATOR))
        .reduce((longest, piece) => Math.max(longest, piece.length), 0);

export const refineTables = (fragment: DocumentFragment): void => {
    for (const table of fragment.querySelectorAll(`table`)) {
        for (const cell of table.querySelectorAll(`th, td`)) {
            for (const node of textNodesIn(cell, [])) {
                addBreaks(node);
            }
            if (longestRun((cell.textContent ?? ``).trim()) > UNPLACEABLE) {
                cell.setAttribute(`data-md-break`, ``);
            }
        }
        alignNumericColumns(table);
    }
};
