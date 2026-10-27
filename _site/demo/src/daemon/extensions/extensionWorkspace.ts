import { STATE_DIR } from "@intentic/constants";
import type { ExtensionSummary, PendingWorkspaceExtension } from "@intentic/sandbox-contract/schemas/extension-updates";
import { refuse } from "@intentic/contract-serve";
import { addDemoExtension, demoExtensions } from "./extensionList";
import { demoQuiet, deskEdition, freshEdition } from "../../mode";
import { pushWorkspaceChanged } from "../broadcast";
import { okAfter } from "../doors";

// Extensions written in this workspace: the one the New extension dialog scaffolds, and one an agent wrote that waits
// for the owner's yes. Each lives in `${STATE_DIR}/config/workspace-extensions/<name>/` and runs from its own bytes, so
// what this module writes is also what `GET /extensions/{id}/bundle` serves.

type ExtensionManifest = ExtensionSummary[`manifest`];

const WORKSPACE_DIR = `${STATE_DIR}/config/workspace-extensions`;
// The range a scaffold asks for: the extension API this build's own first-party extensions are written against.
const ENGINES = `^2.0.0`;
// The scaffold is written to disk and read back before it is listed; long enough for the dialog's button to hold.
const WRITE_MS = 700;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const labelOf = (name: string): string =>
    name
        .split(`-`)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(` `);

const manifestOf = (publisher: string, name: string, extra: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
    publisher,
    name,
    version: `0.1.0`,
    icon: `sparkles`,
    engines: { intentic: ENGINES },
    entry: `extension.js`,
    contributes: { views: [{ id: name, label: labelOf(name), surface: `rail` }] },
    ...extra,
});

// The scaffold's code, as the daemon writes it (workspace-extension-scaffold.ts): one rail view saying where it lives.
const entryOf = (name: string, line: string): string => `import { defineComponent, h } from "vue";

const View = defineComponent({
    name: \`${labelOf(name).replace(/ /gu, ``)}View\`,
    setup() {
        return () =>
            h(\`div\`, { class: \`ui-page\` }, [
                h(\`h1\`, { style: { fontSize: \`1.25rem\`, fontWeight: 600, color: \`var(--color-content)\` } }, \`${labelOf(name)}\`),
                h(\`p\`, { style: { color: \`var(--color-muted)\`, marginTop: \`0.25rem\` } }, \`This view is drawn by ${WORKSPACE_DIR}/${name}/extension.js.\`),
                h(\`div\`, { class: \`ui-card\`, style: { marginTop: \`1rem\` } }, [h(\`p\`, { style: { color: \`var(--color-muted)\` } }, \`${line}\`)]),
            ]);
    },
});

export const activate = (api, context) => {
    context.subscriptions.push(
        api.views.register({
            id: \`${name}\`,
            label: \`${labelOf(name)}\`,
            surface: \`rail\`,
            detect: () => [{ key: \`${name}\`, title: \`${labelOf(name)}\`, icon: \`sparkles\` }],
            view: async () => View,
        }),
    );
};
`;

interface Waiting {
    readonly row: PendingWorkspaceExtension;
    readonly bundle: string;
}

// An agent wrote this one for the support lead: a rail view of the day's orders. It reads a file, so saying yes is a
// decision about reach, which is what the pending list is for.
const DIGEST_NAME = `order-digest`;
const seededWaiting = (): Waiting[] => {
    if (demoQuiet() || deskEdition || freshEdition) {
        return [];
    }
    const manifest = manifestOf(`acme`, DIGEST_NAME, { permissions: { sandbox: [`GET /workspace/file`] } });
    return [
        {
            row: {
                id: `acme.${DIGEST_NAME}`,
                dir: DIGEST_NAME,
                manifest,
                powers: {
                    added: [`runs a UI bundle in your browser`, `its UI calls the sandbox route GET /workspace/file`, `a rail view "Order Digest"`],
                    removed: [],
                    unchanged: [],
                },
                approvedBefore: false,
                digest: `9c4e1f7a2b8d3c6e5f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a`,
            },
            bundle: entryOf(DIGEST_NAME, `Yesterday: 184 orders, 6 refunds asked for, 2 parcels flagged by the carrier.`),
        },
    ];
};

let waiting: Waiting[] | undefined;
const waitingNow = (): Waiting[] => (waiting ??= seededWaiting());

/** The pending list as `/extensions` carries it. */
export const pendingExtensions = (): PendingWorkspaceExtension[] => waitingNow().map((entry) => entry.row);

const listed = (summary: Omit<ExtensionSummary, `enabled`>, bundle: string): void => {
    addDemoExtension({ ...summary, enabled: true }, bundle);
};

// A person creating one approves the scaffold as written, so it is listed and running at once, as the daemon does.
export const createExtension = async (publisher: string, name: string): Promise<{ id: string; dir: string }> => {
    const id = `${publisher}.${name}`;
    if (demoExtensions().some((extension) => extension.id === id)) {
        refuse(`${id} is already installed here`, 409);
    }
    if (waitingNow().some((entry) => entry.row.dir === name) || demoExtensions().some((extension) => extension.manifest.name === name && extension.source === `workspace`)) {
        refuse(`${WORKSPACE_DIR}/${name} already exists`, 409);
    }
    await wait(WRITE_MS);
    listed({ id, manifest: manifestOf(publisher, name), commit: `workspace`, source: `workspace` }, entryOf(name, `Nothing here yet, say what you want this to do.`));
    pushWorkspaceChanged(`${WORKSPACE_DIR}/${name}/`);
    return { id, dir: `${WORKSPACE_DIR}/${name}` };
};

// The yes for the powers that were on screen; a digest that no longer matches is a change made while they read.
export const approveExtension = (id: string, digest: string) => {
    const entry = waitingNow().find((candidate) => candidate.row.id === id) ?? refuse(`no workspace extension with that id is waiting for approval`, 404);
    if (entry.row.digest !== digest) {
        refuse(`the powers it declares changed since they were shown, read them again`, 409);
    }
    return okAfter(() => {
        waiting = waitingNow().filter((candidate) => candidate !== entry);
        listed({ id, manifest: entry.row.manifest, commit: `workspace`, source: `workspace` }, entry.bundle);
        pushWorkspaceChanged(`${WORKSPACE_DIR}/${entry.row.dir}/`);
    });
};

/** The folder a workspace extension was written to, as removal names it. */
export const workspaceDirOf = (extension: ExtensionSummary): string => `${WORKSPACE_DIR}/${extension.manifest.name}`;
