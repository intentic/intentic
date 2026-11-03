import type { CheckoutUsage, StorageReport } from "@intentic/sandbox-contract/schemas/metrics";
import { afterPress, checkoutParts, checkoutTotal, landedReleasable } from "./checkoutsView";

// What the Disk card and a board card read off one conversation's checkout, and what the report says once a press went
// through without a scan.

const row = (over: Partial<CheckoutUsage> & Pick<CheckoutUsage, "id">): CheckoutUsage => ({
    bytes: 0,
    buildOutputBytes: 0,
    overlayBytes: 0,
    state: `idle`,
    can: { cleanBuildOutput: false, release: false, trash: false },
    ...over,
});

const reportOf = (checkouts: readonly CheckoutUsage[]): StorageReport => ({ scanning: false, checkouts: [...checkouts] });

test("a checkout's total is its three parts, and only the non-empty ones are named, largest first", () => {
    const one = row({ id: `c1`, bytes: 300, buildOutputBytes: 20_000, overlayBytes: 0 });
    expect(checkoutTotal(one)).toBe(20_300);
    expect(checkoutParts(one)).toEqual([
        { kind: `buildOutput`, bytes: 20_000 },
        { kind: `checkout`, bytes: 300 },
    ]);
});

test("a clean leaves the row with nothing to clean; a release or a trash takes it off; other rows stay as measured", () => {
    const leftover = row({ id: `c2`, bytes: 50, state: `leftover`, can: { cleanBuildOutput: false, release: false, trash: true } });
    const report = reportOf([row({ id: `c1`, bytes: 300, buildOutputBytes: 2000, can: { cleanBuildOutput: true, release: true, trash: false } }), leftover]);
    expect(afterPress(report, `c1`, `cleanBuildOutput`)?.checkouts).toEqual([
        row({ id: `c1`, bytes: 300, buildOutputBytes: 0, can: { cleanBuildOutput: false, release: true, trash: false } }),
        leftover,
    ]);
    expect(afterPress(report, `c1`, `release`)?.checkouts?.map((one) => one.id)).toEqual([`c2`]);
    expect(afterPress(report, `c2`, `trash`)?.checkouts?.map((one) => one.id)).toEqual([`c1`]);
    // A report from before checkouts were measured has nothing to change.
    expect(afterPress({ scanning: false }, `c1`, `release`)).toEqual({ scanning: false });
    expect(afterPress(undefined, `c1`, `release`)).toBe(undefined);
});

test("only landed checkouts that may be freed are offered all at once", () => {
    const rows = [
        row({ id: `landed`, state: `landed`, can: { cleanBuildOutput: false, release: true, trash: false } }),
        row({ id: `landed-busy`, state: `landed`, can: { cleanBuildOutput: false, release: false, trash: false } }),
        row({ id: `held`, state: `held`, can: { cleanBuildOutput: false, release: true, trash: false } }),
    ];
    expect(landedReleasable(rows).map((one) => one.id)).toEqual([`landed`]);
});
