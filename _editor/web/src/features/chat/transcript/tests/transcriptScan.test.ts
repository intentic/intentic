import { firstChange, firstWhere, newestOf, runningTotal } from "../transcriptScan";

// Each reader must say exactly what a scan of every row says, through every way a transcript changes: a row appended, the
// streamed row replaced, a row in the middle reworded, a row dropped, a page put above, the whole of it rebuilt.

interface Row {
    readonly n: number;
    readonly mark?: true;
}

// A small deterministic generator, so a failure names a sequence that reproduces.
const random = (seed: number): (() => number) => {
    let state = seed;
    return () => {
        state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
        return state / 2_147_483_648;
    };
};

const fresh = (next: () => number): Row => (next() < 0.2 ? { n: Math.floor(next() * 100), mark: true } : { n: Math.floor(next() * 100) });

const change = (rows: readonly Row[], next: () => number): readonly Row[] => {
    const pick = next();
    const at = Math.floor(next() * rows.length);
    if (pick < 0.35 || rows.length === 0) {
        return [...rows, fresh(next)];
    }
    if (pick < 0.65) {
        return rows.map((row, index) => (index === rows.length - 1 ? fresh(next) : row));
    }
    if (pick < 0.75) {
        return rows.map((row, index) => (index === at ? fresh(next) : row));
    }
    if (pick < 0.85) {
        return rows.filter((_, index) => index !== at);
    }
    if (pick < 0.95) {
        return [fresh(next), fresh(next), ...rows];
    }
    return rows.map(() => fresh(next));
};

it(`finds where two snapshots first differ`, () => {
    const a = { n: 1 };
    const b = { n: 2 };
    expect(firstChange([a, b], [a, b, { n: 3 }])).toBe(2);
    expect(firstChange([a, b], [a, { n: 2 }])).toBe(1);
    expect(firstChange([], [a])).toBe(0);
});

it(`reads what a scan of every row reads, through every kind of change`, () => {
    for (const seed of [1, 2, 3, 4, 5]) {
        const next = random(seed);
        const total = runningTotal<Row>((row) => row.n);
        const oldest = firstWhere<Row>((row) => row.mark === true);
        const newest = newestOf<Row, number>((row) => (row.mark === true ? row.n : undefined));
        let rows: readonly Row[] = [];
        for (let step = 0; step < 400; step += 1) {
            rows = change(rows, next);
            expect(total(rows)).toBe(rows.reduce((sum, row) => sum + row.n, 0));
            expect(oldest(rows)).toBe(rows.find((row) => row.mark === true));
            expect(newest(rows)).toBe(rows.findLast((row) => row.mark === true)?.n);
        }
    }
});
