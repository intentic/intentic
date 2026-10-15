import { join } from "node:path";
import { extensionCacheDir } from "@intentic/sandbox-contract/workspace-state";

// This extension's identity, and the one cache file the CLI and the backend share: the EU trusted lists, fetched by
// `e-urzad trust refresh` and read by every verification. A cache, so the workspace watcher ignores it and no backup
// carries it; deleting it only means "trust chain not checked" until the next refresh.

const EXTENSION_ID = "intentic.e-urzad";

export const trustCachePath = (root: string): string => join(root, extensionCacheDir(EXTENSION_ID), "trusted-lists.json");
