import { useEndpoint } from "../../../../client/endpoint/useEndpoint";
import { daemonDecodesGzip } from "../../../../client/sandbox/daemon/uploadEncodings";
import { uploadEncoding } from "../../../../lib/files/uploadEncoding";
import { measuredProtocol, streamCapacity } from "../../../../lib/streamBudget";

// What the link to the active daemon allows an upload, read live since the endpoint can change mid-drop.

// Whether the address in use multiplexes requests; by what the browser negotiated where known (lib/streamBudget.ts).
export const multiplexed = (): boolean => {
    const { daemonBase, usingLocal, degradedTransport } = useEndpoint();
    const kind = degradedTransport.value ? `local-insecure` : usingLocal.value ? `local` : `public`;
    return streamCapacity(kind, measuredProtocol(daemonBase.value)) === Number.POSITIVE_INFINITY;
};

// Gzip for a chunk worth it, to a daemon that decodes it, over a link that is not the loopback shortcut
// (lib/files/uploadEncoding.ts).
export const encodingFor = (files: readonly { readonly path: string; readonly size: number }[]): `gzip` | undefined =>
    uploadEncoding(files, { decodes: daemonDecodesGzip(), local: useEndpoint().usingLocal.value });
