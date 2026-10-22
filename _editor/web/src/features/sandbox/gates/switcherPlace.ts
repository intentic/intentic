import { errorMessage } from "@intentic/base/errors";
import { browserOwnsClick } from "@intentic/ui";
import { computed, type ComputedRef, onMounted, type Ref, ref, watch } from "vue";
import { type Router, useRouter } from "vue-router";
import { localFace } from "../../../app/environments/local";
import { localHost } from "../../../app/environments/localHost";
import { useAccount } from "../../../client/auth/useAccount";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { ADD_SANDBOX_PATH } from "../../../models/sandbox/addSandbox";

// WHERE THE SANDBOX SWITCHER STANDS, the one thing about it that differs between the two windows that draw it. In the
// workspace it stands on a sandbox and moves by selecting another, a route of its own. In the desktop app's window on a
// folder of this computer (app/environments/local.ts) it stands on that folder, and every sandbox, the setup and the
// recently deleted are the workspace's, which the app opens in this window's place (the main window) or its own.

/** The folder this window shows, when it is a local window: its name and where it is on disk. */
export interface ShownFolder {
    readonly name: string;
    readonly path: string;
}

const shownFolder = (): ShownFolder | undefined => {
    const face = localFace();
    return face === undefined ? undefined : { name: face.name, path: face.path };
};

/** A workspace path (`/setup`, the recently deleted): this window's own route, or the workspace opened on it. */
export const openWorkspacePath = async (router: Router, path: string): Promise<void> => {
    if (localFace() === undefined) {
        await router.push(path);
        return;
    }
    await localHost().openWorkspace(path);
};

/** The workspace on one of the account's sandboxes, from a local window (router/sandboxArrival.ts reads the key). */
const openSandboxFromFolder = (sandboxId: string): Promise<void> =>
    localHost().openWorkspace(`/?${new URLSearchParams({ sandbox: sandboxId }).toString()}`);

/** The local window's half of the switcher: what only a window on a folder does, and nothing in the workspace. */
export interface FolderPlace {
    /** The folder this window shows; undefined in the workspace. */
    readonly folder: ComputedRef<ShownFolder | undefined>;
    /** This is a local window, for its whole life, whatever folder it shows. */
    readonly local: boolean;
    /** What went wrong, by the row it is about (a sandbox's id, or `:sign-in`): the app's own sentence. */
    readonly failure: Ref<{ readonly id: string; readonly message: string } | undefined>;
    readonly openFromFolder: (sandboxId: string) => Promise<void>;
    /** The account's Home, available even before it has a sandbox. */
    readonly openHome: (event: MouseEvent) => Promise<void>;
    /** Nobody signed in yet: no sandboxes to list, and the sign-in that brings the workspace instead. */
    readonly signedOut: ComputedRef<boolean>;
    readonly signingIn: ComputedRef<boolean>;
    readonly signIn: () => Promise<void>;
    readonly addSandbox: (event: MouseEvent) => void;
}

export const useFolderPlace = (open: Ref<boolean>): FolderPlace => {
    const router = useRouter();
    const sandbox = useSandbox();
    const { user } = useAccount();
    const folder = computed(shownFolder);
    const local = folder.value !== undefined;
    const failure = ref<{ readonly id: string; readonly message: string } | undefined>(undefined);
    const busy = ref<string | undefined>(undefined);
    const signingIn = computed(() => busy.value === `:sign-in`);

    // One errand at a time; the panel closes on its success, and its failure is said by the row it is about.
    const attempt = async (id: string, act: () => Promise<void>): Promise<void> => {
        if (busy.value !== undefined) {
            return;
        }
        failure.value = undefined;
        busy.value = id;
        try {
            await act();
            open.value = false;
        } catch (error) {
            failure.value = { id, message: errorMessage(error) };
        } finally {
            busy.value = undefined;
        }
    };

    // The window boots on its folder alone (the app keeps the first list off the network), so the account's sandboxes are
    // asked for once it is up, for Alt+1…9, and again each time the panel opens, since nothing else here keeps them fresh.
    if (local) {
        onMounted(() => void sandbox.refresh());
        watch(open, (isOpen) => {
            if (isOpen) {
                failure.value = undefined;
                void sandbox.refresh();
            }
        });
    }

    return {
        folder,
        local,
        failure,
        openFromFolder: (sandboxId) => attempt(sandboxId, () => openSandboxFromFolder(sandboxId)),
        openHome: async (event) => {
            if (local) {
                event.preventDefault();
                await attempt(`:home`, () => openWorkspacePath(router, `/home`));
            } else if (!browserOwnsClick(event)) {
                open.value = false;
            }
        },
        signedOut: computed(() => local && user.value === null),
        signingIn,
        signIn: () => attempt(`:sign-in`, () => localHost().signIn()),
        // The workspace window opens the Add sandbox dialog on this address (SandboxSwitcher.vue): this window cannot
        // read the owner's connected machines, which the dialog offers.
        addSandbox: (event) => {
            event.preventDefault();
            open.value = false;
            void openWorkspacePath(router, ADD_SANDBOX_PATH);
        },
    };
};
