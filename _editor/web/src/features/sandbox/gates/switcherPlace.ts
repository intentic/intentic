import { errorMessage } from "@intentic/base/errors";
import { useT } from "@intentic/ui/i18n";
import { computed, type ComputedRef, onMounted, type Ref, ref } from "vue";
import { type Router, useRouter } from "vue-router";
import { localFace } from "../../../app/environments/local";
import { localHost } from "../../../app/environments/localHost";
import { useAccount } from "../../../client/auth/useAccount";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { ADD_SANDBOX_PATH, LOCAL_ADD_SANDBOX_PATH } from "../../../models/sandbox/addSandbox";
import { useNotifications } from "../../../workbench/notifications/notifications";

// WHERE THE RAIL'S TOP STANDS, the one thing about it that differs between the two windows that draw it. In the
// workspace it stands on a sandbox and moves by selecting another, a route of its own. In the desktop app's window on a
// folder of this computer (app/environments/local.ts) it stands on This computer, and every sandbox, the setup and the
// recently deleted are the workspace's, which the app opens in this window's place (the main window) or its own. Read
// by the logo (SandboxSwitcher.vue), the cluster under it (shell/rail/OtherSandboxes.vue) and the rail unrolled onto
// every sandbox (local/LocalMasterRail.vue), which share one copy of it.

/** The folder this window shows, when it is a local window: its name and where it is on disk. */
export interface ShownFolder {
    readonly name: string;
    readonly path: string;
}

const shownFolder = (): ShownFolder | undefined => {
    const face = localFace();
    return face === undefined ? undefined : { name: face.name, path: face.path };
};

/** A workspace path (Home, the recently deleted): this window's own route, or the workspace opened on it. */
export const openWorkspacePath = async (router: Router, path: string): Promise<void> => {
    if (localFace() === undefined) {
        await router.push(path);
        return;
    }
    await localHost().openWorkspace(path);
};

/** The workspace on one of the account's sandboxes, from a local window (router/sandboxArrival.ts reads the key). */
const openSandboxFromFolder = (sandboxId: string, path = `/`): Promise<void> =>
    localHost().openWorkspace(`${path}?${new URLSearchParams({ sandbox: sandboxId }).toString()}`);

/** The local window's half of the rail's top: what only a window on a folder does, and nothing in the workspace. */
export interface FolderPlace {
    /** The folder this window shows; undefined in the workspace. */
    readonly folder: ComputedRef<ShownFolder | undefined>;
    /** This is a local window, for its whole life, whatever folder it shows. */
    readonly local: boolean;
    /** The workspace on one of the account's sandboxes; a refusal is said in the window's notification lane. */
    readonly openFromFolder: (sandboxId: string) => Promise<void>;
    /** The workspace on one of the account's sandboxes, opened on its settings (`path`, the hub this reader may open). */
    readonly openSettingsFromFolder: (sandboxId: string, path: string) => Promise<void>;
    /** Nobody signed in yet: no sandboxes to list, and the sign-in that brings the workspace instead. */
    readonly signedOut: ComputedRef<boolean>;
    readonly signingIn: ComputedRef<boolean>;
    readonly signIn: () => Promise<void>;
    /** Add sandbox from this window: the sign-in first while nobody is signed in, since a sandbox is made on an account. */
    readonly addSandbox: () => void;
    /**
     * The reader's order of their sandboxes, as the workspace last told the app (localHost.ts `roster`, in the switcher's
     * order): a local window's storage is its own origin's, which never saw Home's drag. Empty in the workspace.
     */
    readonly arranged: Readonly<Ref<readonly string[]>>;
}

// ONE COPY PER WINDOW of what the parts at the rail's top read together (the logo, the cluster under it, the rail
// unrolled onto every sandbox): the workspace's order, and the one errand under way.
// allow(module-state): the local window's one copy of the workspace's order of its sandboxes
const arranged = ref<readonly string[]>([]);
// allow(module-state): the local window's one errand at a time (a sandbox opened, the sign-in)
const busy = ref<string | undefined>(undefined);
// allow(module-state): when the account's sandboxes were last asked for, so parts mounting together ask once
let askedAt = Number.NEGATIVE_INFINITY;
const ASK_AGAIN_MS = 2_000;

const readArranged = async (): Promise<void> => {
    try {
        arranged.value = (await localHost().roster()).sandboxes.map((entry) => entry.id);
    } catch (error) {
        console.warn(`[local] the workspace's order of the sandboxes could not be read:`, error);
    }
};

/** Forgets when the list was last asked for: a test's window starts with none asked. */
export const resetFolderPlace = (): void => {
    askedAt = Number.NEGATIVE_INFINITY;
    arranged.value = [];
    busy.value = undefined;
};

export const useFolderPlace = (): FolderPlace => {
    const t = useT();
    const router = useRouter();
    const sandbox = useSandbox();
    const { user } = useAccount();
    const { report } = useNotifications();
    const folder = computed(shownFolder);
    const local = folder.value !== undefined;
    const signingIn = computed(() => busy.value === `:sign-in`);
    const signedOut = computed(() => local && user.value === null);

    // One errand at a time; a refusal is the app's own sentence, said under what the reader pressed for.
    const attempt = async (id: string, title: () => string, act: () => Promise<void>): Promise<void> => {
        if (busy.value !== undefined) {
            return;
        }
        busy.value = id;
        try {
            await act();
        } catch (error) {
            report({ tone: `problem`, title: title(), detail: errorMessage(error) });
        } finally {
            busy.value = undefined;
        }
    };
    const nameOf = (id: string): string => sandbox.sandboxes.value.find((entry) => entry.id === id)?.name ?? id;

    // The window boots on its folder alone (the app keeps the first list off the network), so the account's sandboxes are
    // asked for once a part that draws them is up: the rail's top at the window's start, and the rail unrolled onto them
    // each time it unrolls, since nothing else here keeps them fresh. Parts mounting together ask once. The workspace's
    // order of them comes with them, from the app's record of what the workspace last said.
    if (local) {
        onMounted(() => {
            const now = Date.now();
            if (now - askedAt < ASK_AGAIN_MS) {
                return;
            }
            askedAt = now;
            void sandbox.refresh();
            void readArranged();
        });
    }

    const signIn = (): Promise<void> => attempt(`:sign-in`, () => t(`local.placeSwitcher.signInFailed`), () => localHost().signIn());
    return {
        folder,
        local,
        arranged,
        openFromFolder: (sandboxId) =>
            attempt(sandboxId, () => t(`local.placeSwitcher.openFailed`, { name: nameOf(sandboxId) }), () => openSandboxFromFolder(sandboxId)),
        openSettingsFromFolder: (sandboxId, path) =>
            attempt(sandboxId, () => t(`local.placeSwitcher.openFailed`, { name: nameOf(sandboxId) }), () => openSandboxFromFolder(sandboxId, path)),
        signedOut,
        signingIn,
        signIn,
        // Made in this window where the app makes one from here (LocalNewSandbox.vue), the reader staying on This
        // computer; an app from before that hands the ask to the workspace window, which opens its own dialog on it.
        // Nobody signed in has no account to make one on: the sign-in comes first, as Home's add asks for it.
        addSandbox: () => {
            if (signedOut.value) {
                void signIn();
                return;
            }
            if (local && localHost().newSandbox !== undefined) {
                void router.push(LOCAL_ADD_SANDBOX_PATH);
                return;
            }
            void openWorkspacePath(router, ADD_SANDBOX_PATH);
        },
    };
};
