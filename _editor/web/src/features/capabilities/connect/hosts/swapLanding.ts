import { EnvironmentSchema } from "@intentic/api-contract";
import { sandboxJson } from "../../../sandbox/client/sandboxClient";
import { sandboxRpc } from "../../../sandbox/client/sandboxRpc";

// What the sandbox answering right now runs, read fresh rather than from the page's cached reads, which predate the swap:
// the overlay a rebuild aims at, and the version an update or a rollback moves. HostRecreate asks these to tell a swap
// that landed from one still running, since the stream carrying it is no sign either way.

/** sha256 of the overlay the answering container was built from; undefined on a stock image. */
export const appliedHash = async (): Promise<string | undefined> => EnvironmentSchema.parse(await sandboxJson(`/environment`)).appliedHash;

/** The version the answering daemon was built as. */
export const runningVersion = async (): Promise<string | undefined> => (await sandboxRpc.system.info()).version;
