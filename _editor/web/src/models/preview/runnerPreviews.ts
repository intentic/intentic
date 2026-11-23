import { sandboxRef } from "@intentic/extension-api";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { type PreviewTarget, runnerPortTarget, runnerPortTargetId } from "./previewModel";

// THE PORTS OF RUNNERS THIS WINDOW HAS PREVIEWED. A conversation that runs on a runner serves on the runner's own
// loopback; `ports.forward({port, runner})` has the runner vet the port and this sandbox mint a preview address for it,
// which no list of this sandbox's names afterwards (`ports.list` is its own ports). So the forward's answer is kept here
// as a preview target, per sandbox, for as long as the window lives, and the preview's targets carry it beside its own.

/** What a runner port's forward reaches; a test's to replace. */
export type RunnerForward = (input: { readonly port: number; readonly runner: string }) => Promise<{ readonly previewUrl?: string | undefined }>;

const forwardDefault: RunnerForward = (input) => sandboxRpc.ports.forward(input);

const held = sandboxRef<readonly PreviewTarget[]>(() => []);

/** The runner ports this window previewed, as preview targets. */
export const runnerPreviewTargets = (): readonly PreviewTarget[] => held.value;

/**
 * Forwards a runner's port and keeps it as a preview target, answering the target. Asking twice is harmless: the
 * daemon hands back the address it made, and the target is replaced. Rejects with the daemon's sentence (a port the
 * runner refuses, a runner offline).
 */
export const previewRunnerPort = async (runner: string, port: number, detail?: string, forward: RunnerForward = forwardDefault): Promise<PreviewTarget> => {
    const { previewUrl } = await forward({ port, runner });
    const target = runnerPortTarget(runner, port, previewUrl, detail);
    held.value = [...held.value.filter((entry) => entry.id !== runnerPortTargetId(runner, port)), target];
    return target;
};
