import { hostSlot } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { manifest } from "./manifest.js";
export const { bindHost, host } = hostSlot(extensionIdOf(manifest));
