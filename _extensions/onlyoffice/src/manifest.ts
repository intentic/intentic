import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import manifestJson from "../intentic-extension.json";

// The package's own intentic-extension.json, validated, the same file the daemon reads beside the baked server bundle.
export const manifest = ExtensionManifestSchema.parse(manifestJson);
