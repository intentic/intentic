import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { defaultGit } from "@intentic/base/git";
import type { SecretStore } from "@intentic/output-cleaners/cleaners";
import type { ListenerMessage } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { dispatchListenerMessage } from "../automations/listeners.js";
import { ciProjects } from "../ci/projects.js";
import type { CompositionCore, Services } from "../composition.js";
import { fetchTracked } from "../git/remote/follow-upstream.js";
import type { StackServices } from "../hosts/stacks/device-stacks.js";
import { defineSlice } from "../seams/slice.js";
import { deployGrantsDocument, fileDeployGrants } from "./deploy-grants.js";
import type { RenderSources } from "./deploy-render.js";
import { deploySecretMarksDocument, fileSecretMarks } from "./deploy-secret-marks.js";
import { createDeployWatch, type DeployWatch } from "./deploy-watch.js";
import { deployWatchDocument, fileDeployWatch } from "./deploy-watch-store.js";
import { createDeploysEngine, type DeploysEngine } from "./deploys-engine.js";
import { deploysDocument, fileDeploysStore } from "./deploys-store.js";

// The deploys engine as the daemon composes it (deploys-engine.ts): its records in the workspace's records, its grants in
// the auth root, its secrets from the sandbox's own store, and its events to the owner's automations; and its watch
// (deploy-watch.ts), whose memory is on the history volume and whose secret marks sit in the auth root beside the grants.
// Every seam reads the finished Services when called, never while this is built; the boot starts both
// (bootstrap/boot-schedulers.ts).

export interface DeploysSlice {
    readonly deploys: DeploysEngine;
    // What deploys by itself (CI, registries, promotion, rotated secrets) and what watches what runs (deploy-watch.ts).
    readonly deployWatch: DeployWatch;
}

// What holds a name this sandbox's own store does not, in a refusal's words; undefined for the store itself.
const heldBy = (source: SecretStore["source"]): string | undefined => {
    switch (source) {
        case "capability":
            return "a connection's vault";
        case "copy":
            return "a copy a keyring on one of your computers shares here";
        case "device":
            return "a keyring on one of your computers";
        case "sandbox":
            return undefined;
    }
};

const secretSources = (whole: () => Services): RenderSources => ({
    own: (name) => whole().sandboxSecrets.get(name),
    heldElsewhere: async (name) => {
        const services = whole();
        const held = (await services.secretRegistry()).find((secret) => secret.name === name);
        const elsewhere = held === undefined ? undefined : heldBy(held.source);
        if (elsewhere !== undefined) {
            return elsewhere;
        }
        // allow(silent-catch): only the refusal's words lose where the name lives; it is refused as not stored either way
        const pointer = (await services.deviceSecrets.listed().catch(() => [])).find((entry) => entry.pointer.name === name);
        return pointer === undefined ? undefined : `the keyring on ${pointer.machine}`;
    },
    gates: () => whole().credentialGates.list(),
});

// The remote a commit is fetched from: `origin`, else the first one the repository names.
const remoteOf = async (dir: string): Promise<string | undefined> => {
    const { stdout } = await defaultGit(dir, ["remote"]);
    const remotes = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
    return remotes.includes("origin") ? "origin" : remotes[0];
};

const fetchRemoteOf =
    (whole: () => Services) =>
    async (dir: string): Promise<string | undefined> => {
        try {
            const remote = await remoteOf(dir);
            if (remote === undefined) {
                return "it has no remote";
            }
            const fetched = await fetchTracked(dir, remote, await whole().daemonGitEnv());
            return fetched.ok ? undefined : fetched.reason;
        } catch (error) {
            return errorMessage(error);
        }
    };

export const deploysSlice = defineSlice<DeploysSlice>({
    build: ({ workspace, authRoot, config, logger, whole }: Pick<CompositionCore, "workspace" | "authRoot" | "config" | "logger" | "whole">) => {
        // The hub is a leaf slice of its own, read when a deploy reaches a computer.
        const device: StackServices = {
            workspace,
            get hostHub() {
                return whole().hostHub;
            },
        };
        const deviceCards = () => whole().capabilities.list();
        const fetchRemote = fetchRemoteOf(whole);
        const dispatch = async (message: ListenerMessage): Promise<void> => {
            await dispatchListenerMessage(whole(), message);
        };
        const deploys = createDeploysEngine({
            root: workspace.root,
            store: fileDeploysStore(join(workspace.root, deploysDocument.path)),
            grantsStore: fileDeployGrants(join(authRoot, deployGrantsDocument.path)),
            device,
            deviceCards,
            secrets: secretSources(whole),
            uses: { record: (use) => whole().secretUses.record(use) },
            fetchRemote,
            dispatch,
            logger,
        });
        const deployWatch = createDeployWatch({
            root: workspace.root,
            engine: deploys,
            device,
            deviceCards,
            store: fileDeployWatch(join(config.historyRoot, deployWatchDocument.path)),
            marks: fileSecretMarks(join(authRoot, deploySecretMarksDocument.path)),
            secretValue: (name) => whole().sandboxSecrets.get(name),
            onSecretsChanged: (listener) => whole().onSecretsChanged(listener),
            projectOf: async (repo) => (await ciProjects(whole())).find((project) => project.repo === repo),
            fetch,
            publicUrl: config.sandbox.publicUrl === "" ? undefined : config.sandbox.publicUrl,
            fetchRemote,
            dispatch,
            logger,
        });
        return { deploys, deployWatch };
    },
    stop: ({ deploys, deployWatch }) => {
        deployWatch.stop();
        deploys.stop();
    },
});
