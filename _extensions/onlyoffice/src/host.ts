import { hostSlot } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { manifest } from "./manifest.js";

// This extension's own host handle, bound by activate(api) before the viewer renders.
export const { bindHost, host } = hostSlot(extensionIdOf(manifest));
