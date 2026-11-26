import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import manifestJson from "../intentic-extension.json" with { type: "json" };

// The package's own intentic-extension.json, validated with the schema the daemon loads it by.
export const manifest = ExtensionManifestSchema.parse(manifestJson);
