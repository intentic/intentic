import { windowRowsOf } from "./sandboxWindows";

// The card's rows, from `ic os screen status` and the names the app knows this computer's sandboxes by.

describe(`the sandbox windows card`, () => {
    it(`lists every sandbox ic lists, by the app's name for it else its slug, in name order`, () => {
        const rows = windowRowsOf(
            {
                available: true,
                reason: null,
                sandboxes: [
                    { slug: `work`, allowed: true, socket: true },
                    { slug: `lab`, allowed: false, socket: false },
                    { slug: `held`, allowed: true, socket: false },
                ],
            },
            [
                { slug: `work`, name: `Website` },
                { slug: `lab`, name: `  ` },
                { slug: `elsewhere`, name: `Not on this screen` },
            ],
        );
        expect(rows).toEqual([
            { slug: `held`, name: `held`, allowed: true, drawing: false },
            { slug: `lab`, name: `lab`, allowed: false, drawing: false },
            { slug: `work`, name: `Website`, allowed: true, drawing: true },
        ]);
    });

    it(`never says a sandbox is drawing that may not, whatever the socket says`, () => {
        const [row] = windowRowsOf({ available: true, reason: null, sandboxes: [{ slug: `work`, allowed: false, socket: true }] }, []);
        expect(row).toEqual({ slug: `work`, name: `work`, allowed: false, drawing: false });
    });
});
