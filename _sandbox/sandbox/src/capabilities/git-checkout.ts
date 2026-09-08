import { join } from "node:path";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { CapabilityCtx } from "./capability.js";

// Basic auth accepted for PATs by GitHub/GitLab. Passed via GIT_CONFIG_* env pairs so the token never lands in the URL,
// .git/config, or a persisted pane log.
export const gitAuthHeader = (token: string): string => `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

// Dot-prefixed so it can never collide with an id (ids start alphanumeric); cloning lands here so a half-cloned
// checkout is never visible at the live dir.
const stagingName = (id: string): string => `.${id}.cloning`;

// Where `keepPrevious` sets the outgoing checkout aside: one version back, revertible once validation (which only
// catches broken, not wrong) can no longer help. Dot-prefixed like the staging name.
export const previousDir = (root: string, id: string): string => join(root, `.${id}.previous`);

// Clones `url` into `<root>/<id>`: stage, optional detached checkout of a pinned ref (full clone; a shallow one can't
// reach an arbitrary sha), optional validate, quiesce, swap. A failure leaves no debris; the previous checkout stays
// live until the swap.
export const checkoutInto = async (
    ctx: CapabilityCtx,
    session: string,
    root: string,
    id: string,
    options: {
        readonly url: string;
        readonly ref?: string | undefined;
        readonly token?: string | undefined;
        // Inspects the staged checkout before it replaces the live dir; throw to abort the swap.
        readonly validate?: ((staging: string) => Promise<void>) | undefined;
        // Runs after validation, before the live dir changes; stops the outgoing processes only once validation passes.
        readonly beforeSwap?: (() => Promise<void>) | undefined;
        // Keeps the outgoing checkout at previousDir() instead of deleting it, so a bad release can be reverted.
        readonly keepPrevious?: boolean | undefined;
    },
): Promise<void> => {
    const staging = join(root, stagingName(id));
    await ctx.files.mkdir(root);
    // A crashed earlier run may leave a stale staging dir; clear it before cloning.
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
        // ENOENT means a first install with nothing to keep; other errors must abort rather than drop the revert copy.
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
