import { createLogger } from "../../logger.js";
import { testConfig } from "../../testing.js";
import type { CursorSlice } from "./cursor-provider.js";

// Cursor's slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const cursorSliceFake = () =>
    ({
        // Nothing connected, unlike Claude's double: the /agent guard depends on Claude but nothing guards on Cursor,
        // so the honest default is unset up.
        cursorStore: {
            read: async () => undefined,
            write: async () => {},
            clear: async () => {},
            list: async () => [],
            credentials: async () => [],
            logger: createLogger(testConfig),
        },
        cursorModels: { models: async () => ({ models: [{ id: "auto", label: "Auto" }], default: "auto" }), item: async () => undefined },
        // Registered but never consulted: with no live turn the gate answers allow, same as an unwired hook service.
        cursorHooks: {
            start: async () => {},
            register: () => () => {},
            ready: () => false,
            paths: () => ({ socket: "", script: "", hooks: "" }),
            close: async () => {},
        },
        async *cursorAgent() {
            yield { kind: "done" };
        },
    }) satisfies CursorSlice;
