import { ExtensionManifestSchema } from "@intentic/extension-manifest";
import json from "../intentic-extension.json";
export const manifest = ExtensionManifestSchema.parse(json);
