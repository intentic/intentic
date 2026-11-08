import { RAW_JSON_ROUTES } from "@intentic/sandbox-contract/protocol/raw/raw-json-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { sandboxJsonAt } from "../../../../client/sandbox/sandboxClient";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import type { AgentReach } from "../../../../models/fleet/agentActions";

// ONE CONVERSATION'S DEBUG BUNDLE (sandbox-contract schemas/diagnostics.ts), saved as one JSON file: its record, its
// timeline and the sandbox's log lines about it, for somebody looking into a problem from outside the sandbox it ran in.
// Read at the press, never cached: it is what the sandbox knows at that moment.

const BUNDLE = `GET /fleet/{handle}/bundle` as const;

// How long the download's object URL outlives the click that started it, in milliseconds.
const DOWNLOAD_HOLD_MS = 10_000;

/** The file it is saved as: the conversation's id, so bundles from one sandbox never share a name. */
export const bundleFileName = (id: string): string => `${id}-bundle.json`;

/**
 * Reads the bundle from the sandbox the conversation runs in (`at`, as the board's other presses name another of the
 * reader's sandboxes; undefined is the active one) and saves it. Answers the file's name.
 */
export const downloadBundle = async (id: string, at: AgentReach = undefined): Promise<string> => {
    const bundle =
        at === undefined
            ? await sandboxRaw(BUNDLE, { params: { handle: id } })
            : await sandboxJsonAt(at, rawRouteUrl(BUNDLE, { handle: id }), RAW_JSON_ROUTES[BUNDLE].output);
    const name = bundleFileName(id);
    const url = URL.createObjectURL(new Blob([`${JSON.stringify(bundle, undefined, 2)}\n`], { type: `application/json` }));
    const link = document.createElement(`a`);
    link.href = url;
    link.download = name;
    link.click();
    // Held past the click: a browser that starts the download a beat later would otherwise find the bytes gone.
    setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_HOLD_MS);
    return name;
};
