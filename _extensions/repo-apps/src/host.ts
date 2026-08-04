import { hostSlot } from "@intentic/extension-api";

// This extension's own host handle — one slot per extension, never the shared module's (hostSlot's own
// comment has the why). Bound by activate(api) before anything renders; read through host() everywhere else.
export const { bindHost, host } = hostSlot(`ext-apps`);
