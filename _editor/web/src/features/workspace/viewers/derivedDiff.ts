import type { DerivedDiff, DiffSourceQuery } from "@intentic/sandbox-contract";
import { sandboxJsonAt } from "../../sandbox/client/sandboxClient";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";

// Both sides of a document's diff as the text fileq renders, the same rendering an agent reads instead of the bytes.
// `at` names another sandbox's daemon (a remote agent's review); the typed client only reaches the active one.
export const readDerivedDiff = (source: DiffSourceQuery, at?: string): Promise<DerivedDiff> =>
    at === undefined ? sandboxRpc.diff.derived(source) : sandboxJsonAt<DerivedDiff>(at, `/diff/derived?${new URLSearchParams(source).toString()}`);
