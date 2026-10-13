import { QueryClient } from "@tanstack/vue-query";

// A real query cache for a suite that reads the workspace tree. Mock the app's cache module with `treeCacheModule` and
// seed through `workspaceTreeKeyFor`, so the tree sits under the very key the explorer stores it by: a stub that handed
// back the tree whatever key was asked let a reader with the wrong key ship, and every chat file link stopped resolving.
export const treeCache = new QueryClient();

// The cache module (lib/queryPersistence) as the tree's reader and writer see it.
export const treeCacheModule = () => ({ queryClient: treeCache, UNPERSISTED: `unpersisted` });
