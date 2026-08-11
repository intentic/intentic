import { join } from "node:path";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { CapabilityCtx } from "./capability.js";

// Basic auth every major git host accepts for PATs (GitHub, GitLab). Rides the runner's env (GIT_CONFIG_* →
// tmux -e pairs), so the token never lands in the URL, .git/config, the visible command line, or the persisted
// pane logs.
export const gitAuthHeader = (token: string): string => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

// A staging name that can never collide with a checkout dir: entry ids must start alphanumeric, this starts
// with a dot. Cloning lands here first so a reader never sees a half-cloned checkout at the live dir.
const stagingName = (id: string): string => `.${id}.cloning`;

// Where `keepPrevious` sets the outgoing checkout aside — the one-version-back that makes an update revertible
// after validation stops being able to help (validation catches broken; it can't catch wrong). Dot-prefixed
// for the same collision-proofing as the staging name.
export const previousDir = (root: string, id: string): string => join(root, `.${id}.previous`);

// Clone `url` into `<root>/<id>` through the visible job session: stage → optional pinned detached checkout →
// optional validate → quiesce → swap. A pinned ref is checked out detached after a full clone (a shallow clone
// can't reach an arbitrary sha). A failed clone/checkout/validate leaves no debris, and on an update the
// previous checkout stays live until the swap. Shared by the plugin and extension handlers.
export const checkoutInto = async (
    ctx: CapabilityCtx,
    session: string,
    root: string,
    id: string,
    options: {
        readonly url: string;
        readonly ref?: string | undefined;
        readonly token?: string | undefined;
        // Inspect the staged checkout before it replaces the live dir; throw to abort the swap.
        readonly validate?: ((staging: string) => Promise<void>) | undefined;
        /* Runs after validation succeeds and before the live dir is touched — the update transaction's quiesce
         * step. This is where the extension handler stops the outgoing checkout's declared processes: stopping
         * them earlier would punish a failed validation (the old version stays live but its processes are
         * down), and not stopping them at all leaves them executing code whose directory is about to vanish. */
        readonly beforeSwap?: (() => Promise<void>) | undefined;
        // Set the outgoing live checkout aside at previousDir() instead of deleting it, so a release that
        // validates but misbehaves at runtime can be reverted. A first install has nothing to keep.
        readonly keepPrevious?: boolean | undefined;
    },
): Promise<void> => {
    const staging = join(root, stagingName(id));
    await ctx.files.mkdir(root);
    // A crashed earlier run may have left a stale staging dir; clean slate before cloning.
    await ctx.files.remove(staging);
    try {
        await ctx.terminalRun.run(session, `git clone ${shellQuote(options.url)} ${shellQuote(stagingName(id))}`, {
            cwd: root,
            window: "clone",
            ...(options.token !== undefined
                ? { env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraheader", GIT_CONFIG_VALUE_0: gitAuthHeader(options.token) } }
                : {}),
        });
        if (options.ref !== undefined) {
            await ctx.terminalRun.run(session, `git checkout --detach -q ${shellQuote(options.ref)}`, { cwd: staging, window: "checkout" });
        }
        await options.validate?.(staging);
    } catch (error) {
        await ctx.files.remove(staging);
        throw error;
    }
    await options.beforeSwap?.();
    const live = join(root, id);
    if (options.keepPrevious === true) {
        const previous = previousDir(root, id);
        await ctx.files.remove(previous);
        // ENOENT means a first install — there is no outgoing checkout to keep. Anything else is a real
        // filesystem failure and must abort rather than quietly discard the one copy a revert would need.
        try {
            await ctx.files.move(live, previous);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                throw error;
            }
        }
    } else {
        await ctx.files.remove(live);
    }
    await ctx.files.move(staging, live);
};
