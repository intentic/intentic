import { runnerIdOfSlug } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import { t } from "../../i18n/index.js";

/* RUNNERS AMONG A MACHINE'S SANDBOXES (2026-11-21). A runner is a sandbox's execution container on another computer, an
   ordinary sandbox container to Docker and to `ic`, listed beside the machine's own sandboxes. It has no name of its own
   from the platform, so until its daemon kept the one its sandbox gave it every runner read "Unnamed sandbox" with nothing
   to say whose it was. A runner row is titled by its name, else its id, and says whose runner it is. */

// Whose runner a container is (the contract's DeviceSandbox `runnerOf`): its parent's address, and the parent's name
// where the runner was told it or the caller resolved it.
export interface RunnerOfRow {
    readonly url: string;
    readonly name?: string | null | undefined;
}

interface RunnerFacts {
    readonly slug: string;
    readonly runnerOf?: RunnerOfRow | null | undefined;
}

/** Whether a container is a runner (a sandbox's execution container, not a person's sandbox): by its parent, else its slug. */
export const isRunnerRow = (sandbox: RunnerFacts): boolean => (sandbox.runnerOf !== undefined && sandbox.runnerOf !== null) || runnerIdOfSlug(sandbox.slug) !== undefined;

/** A runner nobody named reads by its id (its slug past `runner-`), the name its sandbox gave it; undefined for anything else. */
export const runnerName = (sandbox: RunnerFacts | undefined): string | undefined =>
    sandbox === undefined || !isRunnerRow(sandbox) ? undefined : runnerIdOfSlug(sandbox.slug);

// A parent's address as a person reads it when nothing named the sandbox there: its host, else the address as it is.
const hostOf = (url: string): string => (URL.canParse(url) ? new URL(url).hostname : url);

/**
 * A runner's word beside its status: whose runner it is ("runner of intentic"), with the parent's address on hover. Just
 * "runner" when it does not say whose (an ic or a runner older than the field); undefined for a person's sandbox.
 */
export const runnerLine = (sandbox: RunnerFacts | undefined): { readonly text: string; readonly hint: string } | undefined => {
    if (sandbox === undefined || !isRunnerRow(sandbox)) {
        return undefined;
    }
    const parent = sandbox.runnerOf;
    if (parent === undefined || parent === null) {
        return { text: t(`ui.deviceDetail.runner`), hint: t(`ui.deviceDetail.runnerHint`) };
    }
    const name = parent.name?.trim() || hostOf(parent.url);
    return { text: t(`ui.deviceDetail.runnerOf`, { name }), hint: parent.url };
};
