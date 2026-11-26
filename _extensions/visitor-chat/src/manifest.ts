import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import manifestJson from "../intentic-extension.json";

// The package's own intentic-extension.json, validated, the same file the daemon reads from the image. Parsing here
// keeps the compiled-in path honest with the loaded path.
export const manifest = ExtensionManifestSchema.parse(manifestJson);
