import { hostSlot } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { manifest } from "./manifest.js";

// This extension's own host handle, one slot per extension, never the shared module's (hostSlot's own comment has
// the why), labelled with the manifest's own id. Bound by activate(api) before anything renders; read through host()
// everywhere else.
export const { bindHost, host } = hostSlot(extensionIdOf(manifest));
