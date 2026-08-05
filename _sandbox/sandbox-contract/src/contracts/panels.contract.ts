import { oc } from "@orpc/contract";
import { OkSchema, PanelRepoParamSchema, PanelsListSchema } from "../schemas.js";

// Per-repository dev servers + the content facts the web app's extensions detect on. `list` enumerates every
// repo with its runtime status + facts; `start`/`stop` drive the repo's dev server. Their tmux sessions list
// on the global GET /system/terminals (the web app's one terminal panel); the interactive I/O is the
// /system/terminal WebSocket.
export const panelsContract = {
    list: oc.route({ method: "GET", path: "/panels" }).output(PanelsListSchema),
    start: oc.route({ method: "POST", path: "/panels/{repo}/start" }).input(PanelRepoParamSchema).output(OkSchema),
    stop: oc.route({ method: "POST", path: "/panels/{repo}/stop" }).input(PanelRepoParamSchema).output(OkSchema),
};
