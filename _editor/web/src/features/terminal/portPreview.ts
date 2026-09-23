import { openForwardedPort } from "@intentic/ui";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";

/* Ctrl+clicking a localhost link in a terminal. */

export const openLoopbackPreview = (link: { port: number; path: string }): void =>
    openForwardedPort({
        port: link.port,
        path: link.path,
        forward: async (port) => (await sandboxRpc.ports.forward({ port })).previewUrl,
    });
