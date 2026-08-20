import type { PortForwardResult } from "@intentic/sandbox-contract";
import { openForwardedPort } from "@intentic/ui";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";

/* Ctrl+clicking a localhost link in a terminal. The reading of the link and the tab-opening dance both live in
 * the kit (@intentic/ui portPreview) — the Ports extension does exactly this from a button and could reach
 * nothing in this app. All that belongs here is which client talks to this sandbox's daemon. */

export const openLoopbackPreview = (link: { port: number; path: string }): void =>
    openForwardedPort({
        port: link.port,
        path: link.path,
        forward: async (port) => (await sandboxJson<PortForwardResult>(`/ports/forward`, jsonBody(`POST`, { port }))).previewUrl,
    });
