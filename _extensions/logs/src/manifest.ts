import { ExtensionManifestSchema } from "@intentic/extension-api";
import manifestJson from "../intentic-extension.json";

// The package's own intentic-extension.json, validated — the same file a git-installed extension ships and the
// daemon reads. Parsing here (not trusting the literal) keeps the compiled-in path honest with the loaded path.
export const manifest = ExtensionManifestSchema.parse(manifestJson);
