import { join } from "node:path";
import type { CompositionCore } from "../composition.js";
import { defineSlice } from "../seams/slice.js";
import { fileShareStore, sharesDocument, type ShareStore } from "./share-store.js";

export interface ShareSlice {
    // Which conversations are published as shareable pages; the index only, pages live in the workspace outbox.
    readonly shares: ShareStore;
}

export const shareSlice = defineSlice<ShareSlice>({
    build: ({ config }: Pick<CompositionCore, "config">) => ({ shares: fileShareStore(join(config.historyRoot, sharesDocument.path)) }),
});
