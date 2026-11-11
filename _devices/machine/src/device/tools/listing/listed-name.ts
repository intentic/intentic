import { z } from "zod";

// ic calls the owner's name for a sandbox `displayName` (read off its /history/presentation.json, loopback.rs); the
// contract (DeviceSandboxSchema) calls it `name`. Without this the name was dropped and every reader saw only slugs,
// which is how an agent asked to move "translations" had to query the platform's database to learn which slug that was
// (2026-11-11). The logo beside it is a data: URL, too big for a model's listing, and the contract has no field for it.

const DisplayNameSchema = z.string().trim().min(1);

// One row of `ic sandbox list --json` as it arrived: JSON values, read before the contract reads them.
const ListedRowSchema = z.record(z.string(), z.json());
type ListedRow = z.infer<typeof ListedRowSchema>;

/** The row with `name` filled from ic's `displayName` when ic named the sandbox and the row has no `name` of its own. */
export const withName = <Row extends ListedRow>(row: Row): Row => {
    const named = DisplayNameSchema.safeParse(row["displayName"]);
    return row["name"] === undefined && named.success ? { ...row, name: named.data } : row;
};
