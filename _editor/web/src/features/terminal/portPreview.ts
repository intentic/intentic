import type { PortForwardResult } from "@intentic/sandbox-contract";
import { openForwardedPort } from "@intentic/ui";
import { sandboxJson } from "../sandbox/client/sandboxClient";
import { jsonBody } from "../sandbox/client/jsonBody";

/* Ctrl+clicking a localhost link in a terminal. */

export const openLoopbackPreview = (link: { port: number; path: string }): void =>
    openForwardedPort({
        port: link.port,
        path: link.path,
        forward: async (port) => (await sandboxJson<PortForwardResult>(`/ports/forward`, jsonBody(`POST`, { port }))).previewUrl,
    });
