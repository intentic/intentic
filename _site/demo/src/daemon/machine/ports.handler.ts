import { forwardPort, portsList, unforwardPort } from "./listeningPorts";
import type { PreviewGuard } from "@intentic/sandbox-contract/schemas/ports";
import type { Doors } from "../doors";

// Who may open this sandbox's previews from outside, as the owner last set it: anyone with the address, until changed.
let guard: PreviewGuard = { scope: `off` };

// What listens in the sandbox, and the preview proxy's slots it can be given (daemon/listeningPorts.ts).
export const portsDoors = {
    list: portsList,
    forward: forwardPort,
    unforward: unforwardPort,
    previewGuard: () => guard,
    setPreviewGuard: (next) => {
        guard = next;
        return guard;
    },
    // The demo's previews are served by the page itself (world/elements.ts), which asks nobody to sign in, so the
    // address goes on unchanged, as the daemon hands it back where nothing guards it.
    previewPass: ({ url }) => ({ url }),
} satisfies Doors<`ports`>;
