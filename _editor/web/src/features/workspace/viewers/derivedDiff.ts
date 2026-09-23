import type { DerivedDiff, DiffSourceQuery } from "@intentic/sandbox-contract";
import { sandboxRpc } from "../../sandbox/client/sandboxRpc";

// Both sides of a document's diff as the text fileq renders, the same rendering an agent reads instead of the bytes.
// `at` names another sandbox's daemon (a remote agent's review); absent, the active one.
export const readDerivedDiff = (source: DiffSourceQuery, at?: string): Promise<DerivedDiff> => sandboxRpc.diff.derived(source, { context: { at } });
