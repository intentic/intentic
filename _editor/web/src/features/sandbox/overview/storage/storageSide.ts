import { StorageCategoryIdSchema } from "@intentic/sandbox-contract/schemas/metrics";
import { z } from "zod";
import type { SideInput } from "../../../../workbench/side/sideTabs";
import type { DiskTile } from "./diskMap";

// The core's disk side view: one category of the Disk card's map as a page beside the Overview, so pressing a tile never
// takes the reader off the card. Its input is built and parsed here, so the opener (SandboxStorageCard), the body
// (SideStorage.vue) and the registration (coreSideViews.ts) cannot disagree about what a disk tab holds.

export const STORAGE_SIDE_VIEW = `storage`;

// The map's one tile for every category too small to name (diskMap.ts mapTiles): its page lists them.
export const SMALLER = `smaller`;

export const StoragePageKeySchema = z.union([StorageCategoryIdSchema, z.literal(SMALLER)]);
export type StoragePageKey = z.infer<typeof StoragePageKeySchema>;

export const StorageSideInputSchema = z.object({ category: StoragePageKeySchema });

export const storageSideInput = (category: StoragePageKey): SideInput => ({ category });

export const pageKeyOf = (tile: DiskTile): StoragePageKey => (tile.kind === `category` ? tile.id : SMALLER);
