import { openForwardedPort } from "@intentic/ui";
import { reportClient } from "../../app/clientDiagnostics";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useEndpoint } from "../../client/endpoint/useEndpoint";

/* Ctrl+clicking a localhost link in a terminal, or a tap on one in a chat message. */

// A forward that got no answer at all (fetch's TypeError, "Failed to fetch") leaves no line in the daemon's log, since
// it may never have reached the daemon: this line, with the failed call's request id that reportClient attaches, is
// the only record of which route the browser was on when it happened.
const forward = async (port: number): Promise<string | undefined> => {
    try {
        return (await sandboxRpc.ports.forward({ port })).previewUrl;
    } catch (error) {
        if (error instanceof TypeError) {
            reportClient(`preview.forward-unanswered`, `forwarding port ${port} got no answer: ${error.message}`, {
                fields: { port, loopback: useEndpoint().usingLocal.value },
            });
        }
        throw error;
    }
};

// The address the daemon lists for the port once it is forwarded: what the Ports view's link opens.
const listed = async (port: number): Promise<string | undefined> => {
    const { ports } = await sandboxRpc.ports.list();
    return ports.find((entry) => entry.port === port && entry.forwarded)?.previewUrl;
};

export const openLoopbackPreview = (link: { port: number; path: string }): void => openForwardedPort({ port: link.port, path: link.path, forward, listed });
