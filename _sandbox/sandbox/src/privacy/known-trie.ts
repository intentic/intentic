// The trie known-matcher.ts walks a text through: a node per unit of a value as its spelling compares it (a code point,
// lower-cased unless the spelling keeps case). Nodes are numbers and their edges sit in typed arrays rather than a map per
// node: tens of thousands of values make hundreds of thousands of nodes, and most have one child, so a node's first child
// sits in `firstUnit`/`firstChild` and only a node that branches keeps a map of the rest.

export const NONE = -1;
const ASCII = 128;

const grown = (array: Int32Array, size: number): Int32Array => {
    if (size <= array.length) {
        return array;
    }
    const next = new Int32Array(Math.max(size, array.length * 2)).fill(NONE);
    next.set(array);
    return next;
};

export class UnitTrie {
    // Units are numbered as first seen.
    private readonly unitIds = new Map<string, number>();
    // Each ASCII character's unit number as compared with its case kept, and lower-cased; NONE while no value holds it.
    // Most text is ASCII, and these spare it a string and a map lookup per character.
    private readonly keptAscii = new Int32Array(ASCII).fill(NONE);
    private readonly lowerAscii = new Int32Array(ASCII).fill(NONE);
    private firstUnit: Int32Array = new Int32Array(1024).fill(NONE);
    private firstChild: Int32Array = new Int32Array(1024).fill(NONE);
    private readonly branches = new Map<number, Map<number, number>>();
    private nodes = 0;

    newNode(): number {
        this.nodes += 1;
        this.firstUnit = grown(this.firstUnit, this.nodes);
        this.firstChild = grown(this.firstChild, this.nodes);
        return this.nodes - 1;
    }

    // The node `units` lead to from `root`, made as needed.
    insert(root: number, units: readonly string[]): number {
        let node = root;
        for (const unit of units) {
            const id = this.unitId(unit);
            const existing = this.child(node, id);
            node = existing === NONE ? this.attach(node, id) : existing;
        }
        return node;
    }

    child(node: number, unit: number): number {
        return this.firstUnit[node] === unit ? this.firstChild[node]! : (this.branches.get(node)?.get(unit) ?? NONE);
    }

    // The unit number of the code point `code` as compared, its case kept or lower-cased; NONE for one no value holds.
    // `unit` spells it as compared, asked only outside ASCII (known-matcher.ts unitOf).
    unitOf(code: number, keepCase: boolean, unit: () => string): number {
        if (code < ASCII) {
            return (keepCase ? this.keptAscii : this.lowerAscii)[code]!;
        }
        return this.unitIds.get(unit()) ?? NONE;
    }

    private attach(node: number, unit: number): number {
        const made = this.newNode();
        if (this.firstUnit[node] === NONE) {
            this.firstUnit[node] = unit;
            this.firstChild[node] = made;
        } else {
            const more = this.branches.get(node) ?? new Map<number, number>();
            more.set(unit, made);
            this.branches.set(node, more);
        }
        return made;
    }

    private unitId(unit: string): number {
        const known = this.unitIds.get(unit);
        if (known !== undefined) {
            return known;
        }
        const id = this.unitIds.size;
        this.unitIds.set(unit, id);
        for (let code = 0; code < ASCII; code += 1) {
            const char = String.fromCharCode(code);
            if (char === unit) {
                this.keptAscii[code] = id;
            }
            if (char.toLowerCase() === unit) {
                this.lowerAscii[code] = id;
            }
        }
        return id;
    }
}
