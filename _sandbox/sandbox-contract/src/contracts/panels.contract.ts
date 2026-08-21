import { oc } from "@orpc/contract";
import { OkSchema, PanelRepoParamSchema, PanelsListSchema } from "../schemas.js";

// Per-repository dev servers + the content facts the web app's extensions detect on. `list` enumerates every
// repo with its runtime status + facts; `start`/`stop` drive the repo's dev server. Their tmux sessions list
// on the global GET /system/terminals (the web app's one terminal panel); the interactive I/O is the
// /system/terminal WebSocket.
export const panelsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/panels",
            summary: "Repos you can run and preview",
            description: "Every repo with whether its dev server is up and what the sandbox worked out about its contents.",
        })
        .output(PanelsListSchema),
    start: oc
        .route({
            method: "POST",
            path: "/panels/{repo}/start",
            summary: "Start a repo's dev server",
            description: "Brings the repo's own runnable app up in a terminal you can attach to, so its preview address starts answering.",
        })
        .input(PanelRepoParamSchema)
        .output(OkSchema),
    stop: oc
        .route({
            method: "POST",
            path: "/panels/{repo}/stop",
            summary: "Stop a repo's dev server",
            description: "Shuts it down and frees the port.",
        })
        .input(PanelRepoParamSchema)
        .output(OkSchema),
};
