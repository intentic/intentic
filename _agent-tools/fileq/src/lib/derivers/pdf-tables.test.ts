import { type PositionedItem, pageText } from "./pdf-tables.js";

// pdf.js text items as a page hands them over, built by position: each glyph run is half its font size wide per
// character, the width pdf.js reports for a typical proportional font near enough for gaps to read as they would.
interface At {
    readonly size?: number;
    readonly eol?: boolean;
    readonly width?: number;
    readonly rotated?: boolean;
}

const item = (str: string, x: number, y: number, at: At = {}): PositionedItem => {
    const size = at.size ?? 10;
    return {
        str,
        transform: at.rotated === true ? [0, size, -size, 0, x, y] : [size, 0, 0, size, x, y],
        width: at.width ?? str.length * size * 0.5,
        height: size,
        hasEOL: at.eol ?? false,
    };
};

// One visual line of prose as one item ending the line, the way most producers draw running text.
const line = (text: string, x: number, y: number, size = 10): PositionedItem => item(text, x, y, { size, eol: true });

// The page as it read before tables: items in drawing order, a break where pdf.js saw one, spaces folded.
const plainJoin = (items: readonly PositionedItem[]): string =>
    items
        .map((each) => each.str + (each.hasEOL ? "\n" : ""))
        .join("")
        .replaceAll(/[ \t]+/g, " ")
        .trim();

// A row of cells at the given x positions, the last one ending the line.
const row = (y: number, cells: readonly (readonly [number, string])[]): PositionedItem[] =>
    cells.map(([x, text], index) => item(text, x, y, { eol: index === cells.length - 1 }));

const COLUMNS = [80, 170, 240, 310, 380] as const;

describe("pageText", () => {
    test("a page of prose reads exactly as its items joined in drawing order", () => {
        const items = [
            line("Quarterly results", 72, 720, 14),
            item("Revenue grew ", 72, 690),
            item("in every region", 137, 690, { eol: true }),
            line("and margins held through the year.", 72, 678),
            item("", 72, 666, { eol: true }),
            line("Outlook  remains   steady.", 72, 654),
        ];
        expect(pageText(items)).toBe(plainJoin(items));
    });

    test("a borderless table drawn column by column comes back row by row, each value under its own header", () => {
        // Drawn the way the stream order scrambled it: every value of a column before the next column.
        const header = row(620, [
            [COLUMNS[0], "SKU"],
            [COLUMNS[1], "Bin"],
            [COLUMNS[2], "Expected"],
            [COLUMNS[3], "Actual"],
            [COLUMNS[4], "Status"],
        ]);
        const byColumn = [
            item("SKU-1", COLUMNS[0], 596),
            item("SKU-2", COLUMNS[0], 572),
            item("A-12", COLUMNS[1], 596),
            item("450", COLUMNS[2], 596),
            item("780", COLUMNS[2], 572),
            item("778", COLUMNS[3], 572),
            item("OK", COLUMNS[4], 572, { eol: true }),
        ];
        const items = [line("Inventory", 72, 660), ...header, ...byColumn, line("Signed off by the warehouse lead.", 72, 540)];
        expect(pageText(items)).toBe(
            [
                "Inventory",
                "",
                "| SKU | Bin | Expected | Actual | Status |",
                "| --- | --- | --- | --- | --- |",
                "| SKU-1 | A-12 | 450 |  |  |",
                "| SKU-2 |  | 780 | 778 | OK |",
                "",
                "Signed off by the warehouse lead.",
            ].join("\n"),
        );
    });

    test("the table sits where the drawing order first reaches it, and the prose around it keeps its order", () => {
        const table = [
            ...row(500, [
                [80, "Item"],
                [200, "Qty"],
                [300, "Price"],
            ]),
            ...row(486, [
                [80, "Bolt"],
                [200, "4"],
                [300, "$1.00"],
            ]),
        ];
        // The closing line is drawn first though it sits lowest on the page.
        const items = [line("Thank you for your order.", 72, 300), line("Order 1182", 72, 560), ...table];
        expect(pageText(items)).toBe(
            ["Thank you for your order.\nOrder 1182", "| Item | Qty | Price |\n| --- | --- | --- |\n| Bolt | 4 | $1.00 |"].join("\n\n"),
        );
    });

    test("a two-field form and rows of two cells are no table: three columns must recur", () => {
        const items = [
            ...row(700, [
                [72, "Name:"],
                [180, "Universal Studios"],
            ]),
            ...row(688, [
                [72, "Category:"],
                [180, "Film Distributor"],
            ]),
            ...row(676, [
                [72, "Customer ID:"],
                [180, "CUST-98765"],
            ]),
        ];
        expect(pageText(items)).toBe(plainJoin(items));
    });

    test("margin line numbers beside two columns of prose make no table", () => {
        const left = "The method converges for every input we tried and is";
        const right = "Results in Table 2 hold across the three data sets we";
        const items = Array.from({ length: 8 }, (_, index) => {
            const y = 700 - index * 12;
            return [item(String(160 + index), 40, y), item(`${left} ${index}`, 72, y, { width: 220 }), item(`${right} ${index}`, 310, y, { width: 220, eol: true })];
        }).flat();
        expect(pageText(items)).toBe(plainJoin(items));
    });

    test("a cell's second line joins the table as its own row, and a line drawn over the gap between two rows stays out", () => {
        const items = [
            ...row(400, [
                [50, "Ln"],
                [100, "Title"],
                [260, "Format"],
                [330, "Rate"],
            ]),
            ...row(388, [
                [50, "1"],
                [100, "Holiday Spectacular"],
                [260, "IMAX 3D"],
                [330, "$250"],
            ]),
            item("(Runtime: 142 min)", 100, 378, { size: 8, eol: true }),
            ...row(364, [
                [50, "2"],
                [100, "Winter Wonderland"],
                [260, "Standard"],
                [330, "$150"],
            ]),
            ...row(352, [
                [50, "3"],
                [100, "New Year Mystery"],
                [260, "4DX"],
                [330, "$300"],
            ]),
            // A footer printed across the table, between rows 2 and 3.
            line("All showtimes are approximate and subject to change.", 50, 358, 6),
        ];
        expect(pageText(items)).toBe(
            [
                "| Ln | Title | Format | Rate |",
                "| --- | --- | --- | --- |",
                "| 1 | Holiday Spectacular | IMAX 3D | $250 |",
                "|  | (Runtime: 142 min) |  |  |",
                "| 2 | Winter Wonderland | Standard | $150 |",
                "| 3 | New Year Mystery | 4DX | $300 |",
                "",
                "All showtimes are approximate and subject to change.",
            ].join("\n"),
        );
    });

    test("a heading spanning a label and its value does not merge their columns", () => {
        const items = [
            ...row(500, [
                [100, "Customer Information"],
                [380, "Vehicle Information"],
            ]),
            ...row(486, [
                [77, "Insured name"],
                [158, "Gabriel Diaz"],
                [310, "Year"],
                [370, "2022"],
            ]),
            ...row(472, [
                [77, "Claim #"],
                [158, "SF-1008"],
                [310, "Make"],
                [370, "Jeep"],
            ]),
        ];
        expect(pageText(items)).toBe(
            [
                // A spanning cell goes to the column it overlaps most.
                "|  | Customer Information |  | Vehicle Information |",
                "| --- | --- | --- | --- |",
                "| Insured name | Gabriel Diaz | Year | 2022 |",
                "| Claim # | SF-1008 | Make | Jeep |",
            ].join("\n"),
        );
    });

    test("right-aligned amounts of different lengths share their column", () => {
        // Each amount ends at x = 400, so where it starts depends on how many digits it has.
        const amount = (text: string, y: number): PositionedItem => item(text, 400 - text.length * 5, y, { eol: true });
        const items = [
            ...row(300, [
                [72, "Account"],
                [200, "Region"],
            ]),
            amount("Balance", 300),
            ...row(288, [
                [72, "Cash"],
                [200, "EU"],
            ]),
            amount("1,250,000.00", 288),
            ...row(276, [
                [72, "Bonds"],
                [200, "US"],
            ]),
            amount("75.10", 276),
        ];
        expect(pageText(items)).toBe(
            ["| Account | Region | Balance |", "| --- | --- | --- |", "| Cash | EU | 1,250,000.00 |", "| Bonds | US | 75.10 |"].join("\n"),
        );
    });

    test("on a two-column page a table in one column takes none of the other column's lines", () => {
        const prose = (index: number): string => `Line ${index} of the left column runs on for quite a while here`;
        const left = Array.from({ length: 10 }, (_, index) => item(prose(index), 54, 700 - index * 12, { width: 230, eol: true }));
        const right = [
            ...Array.from({ length: 6 }, (_, index) => item(`Right column line ${index} carries ordinary prose text too`, 310, 700 - index * 12, { width: 230, eol: true })),
            ...row(628, [
                [320, "Set"],
                [400, "Naive"],
                [460, "Flexible"],
            ]),
            ...row(616, [
                [320, "Breast"],
                [400, "95.9"],
                [460, "96.7"],
            ]),
            ...row(604, [
                [320, "Glass"],
                [400, "61.9"],
                [460, "83.8"],
            ]),
        ];
        const text = pageText([...left, ...right]);
        expect(text).toContain("| Set | Naive | Flexible |\n| --- | --- | --- |\n| Breast | 95.9 | 96.7 |\n| Glass | 61.9 | 83.8 |");
        expect(text.startsWith(plainJoin(left))).toBe(true);
        expect(text).not.toContain(`| ${prose(6)}`);
    });

    test("a pipe inside a cell is escaped so it cannot end the cell", () => {
        const items = [
            ...row(300, [
                [72, "Flag"],
                [160, "Meaning"],
                [300, "Default"],
            ]),
            ...row(288, [
                [72, "-a|-b"],
                [160, "either"],
                [300, "off"],
            ]),
        ];
        expect(pageText(items)).toContain("| -a\\|-b | either | off |");
    });

    test("rotated text takes no part in a table", () => {
        const items = [
            ...row(300, [
                [72, "A"],
                [160, "B"],
                [300, "C"],
            ]),
            item("DRAFT", 30, 280, { rotated: true }),
            ...row(288, [
                [72, "1"],
                [160, "2"],
                [300, "3"],
            ]),
        ];
        expect(pageText(items)).toBe(["| A | B | C |\n| --- | --- | --- |\n| 1 | 2 | 3 |", "DRAFT"].join("\n\n"));
    });
});
