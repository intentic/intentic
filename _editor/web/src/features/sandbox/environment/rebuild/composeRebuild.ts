// WHAT A REBUILD IS FOR A SANDBOX DOCKER COMPOSE RUNS (SANDBOX_MANAGER). `ic`'s swap would start a container Compose
// does not know, and its one-liner may not even be runnable where Compose lives (Komodo, Portainer, a NAS panel). The
// container is whatever Compose's file says it is, so the rebuild is a new file followed by Compose's own redeploy.
//
// (2026-11-11) The card offers the whole regenerated file, rendered from the run contract (@intentic/sandbox-run/compose)
// as the setup page's is, where it used to offer a snippet of service keys and a hash line to splice into the owner's
// file. The splice was a third hand copy of the run contract, and it missed what the setup file had missed with it (the
// stop grace, the key bind, the directive stamps). The file builds the approved recipe itself (`build:` when it has
// steps, its runtime directives as service keys) and stamps SANDBOX_ENVIRONMENT_HASH, which is how the sandbox knows it
// runs this recipe; its credentials stay in the `.env` the folder already has.

import { recipeBuilds, type SetupComposeArgs, setupComposeFile } from "@intentic/sandbox-run/compose";

// What the editor knows about the sandbox beside its recipe: the same facts the setup page renders its file from.
export type ComposeRebuildContext = Omit<SetupComposeArgs, `image` | `recipe` | `existingStorage`>;

export interface ComposeRebuild {
    // The sandbox's whole Compose file, building this recipe.
    readonly file: string;
    // Whether Compose builds an image (the recipe has steps), or only runs the base with the recipe's privileges.
    readonly builds: boolean;
}

// The base a recipe builds on: its FROM, which the daemon composed against; the published image when it names none.
export const recipeBaseOf = (content: string): string =>
    /^FROM\s+(\S+)/imu.exec(content)?.[1] ?? `ghcr.io/intentic/sandbox:stable`;

// Pure: the file for one approved recipe, on the base it names.
export const composeRebuildOf = (hash: string, content: string, context: ComposeRebuildContext): ComposeRebuild => ({
    file: setupComposeFile({ ...context, image: recipeBaseOf(content), recipe: { hash, content }, existingStorage: true }),
    builds: recipeBuilds(content),
});
