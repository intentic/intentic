import { hostSlot } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { manifest } from "./manifest.js";

// This extension's host handle, bound by activate(api) before the view renders.
export const { bindHost, host } = hostSlot(extensionIdOf(manifest));
