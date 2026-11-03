import type { CheckoutPress, CheckoutUsage, StorageReport } from "@intentic/sandbox-contract/schemas/metrics";

// How the Disk card reads the per-conversation checkouts (StorageReport.checkouts, the daemon's checkout-usage.ts): what
// one holds in all, which parts to name, and what the report says once a press has gone through. Pure, so the card and
// the agent cards draw the same figures.

export const checkoutTotal = (row: CheckoutUsage): number => row.bytes + row.buildOutputBytes + row.overlayBytes;

// The parts worth naming under a row, largest first; an empty part says nothing.
export type CheckoutPart = { readonly kind: `checkout` | `buildOutput` | `overlay`; readonly bytes: number };

export const checkoutParts = (row: CheckoutUsage): readonly CheckoutPart[] =>
    (
        [
            { kind: `checkout`, bytes: row.bytes },
            { kind: `buildOutput`, bytes: row.buildOutputBytes },
            { kind: `overlay`, bytes: row.overlayBytes },
        ] as const
    )
        .filter((part) => part.bytes > 0)
        .toSorted((left, right) => right.bytes - left.bytes);

// The report as it stands once a press went through, without walking the disk again: a clean leaves the row with no
// build output to offer, a release or a trash takes the row off. Every other figure stays as the scan measured it.
export const afterPress = (report: StorageReport | undefined, id: string, press: CheckoutPress): StorageReport | undefined => {
    if (report?.checkouts === undefined) {
        return report;
    }
    const checkouts =
        press === `cleanBuildOutput`
            ? report.checkouts.map((row) => (row.id === id ? { ...row, buildOutputBytes: 0, can: { ...row.can, cleanBuildOutput: false } } : row))
            : report.checkouts.filter((row) => row.id !== id);
    return { ...report, checkouts };
};

// Landed work is on main already: its checkouts are the first that may all go at once.
export const landedReleasable = (rows: readonly CheckoutUsage[]): readonly CheckoutUsage[] =>
    rows.filter((row) => row.state === `landed` && row.can.release);

// How many rows the card lists before folding the rest behind one "show all": a sandbox can hold a hundred checkouts.
export const LEADING_CHECKOUTS = 8;

// A conversation's checkout is worth a mark on its board card from this size up; under it the card stays quiet.
export const CARD_DISK_MARK_BYTES = 1024 ** 3;
