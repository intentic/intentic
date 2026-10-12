import { type RawBytesRouteKey, rawRoutePath } from "@intentic/sandbox-contract";
import { sandboxUpload } from "./sandboxClient";

// A `bytes` route's upload with progress: the body goes up in parts (or whole, for a tar the caller keeps to about one
// part's size) over the upload client's own transport, since a fetch reports no progress and a stalled one has no
// watchdog. The same route table names it, so the path is spelled once; `at` aims it at another sandbox of the account.
export function sandboxRawUpload(
    key: RawBytesRouteKey,
    body: Blob,
    opts: {
        readonly query?: Readonly<Record<string, string>>;
        readonly onProgress?: (loaded: number) => void;
        readonly signal?: AbortSignal;
        readonly at?: string;
        readonly whole?: boolean;
    } = {},
): Promise<void> {
    const { query, ...rest } = opts;
    const search = query === undefined ? `` : `?${new URLSearchParams(query).toString()}`;
    return sandboxUpload(`${rawRoutePath(key)}${search}`, body, rest);
}
