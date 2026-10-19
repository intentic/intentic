import { hostSlot } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { manifest } from "./manifest.js";

// This extension's own host handle in the hosted editor, bound by activate(api). The app itself (src/app) never reads
// it: it is handed a PasswordsPort, so the desktop app can mount the same app with no extension host at all.
export const { bindHost, host } = hostSlot(extensionIdOf(manifest));
