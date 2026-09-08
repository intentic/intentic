import { watch } from "vue";
import type { RouteRecordNormalized } from "vue-router";
import { router } from "../../../router";
import { readWindowState, writeWindowState } from "../../../shell/window/windowStore";
import { useSandbox } from "./useSandbox";

// Remembers which screen each sandbox was last on and lands there on a switch, since a route naming something
// in the outgoing sandbox means nothing in the incoming one. Kept per window. Registered at module scope, like
// sandboxScope, since the active sandbox can change while the shell is unmounted.

const screenKey = (sandboxId: string): string => `intentic.sandboxScreen.${sandboxId}`;

// A screen of a sandbox is a route inside the workspace shell (path `/`); account pages like /login and /setup
// belong to no sandbox and must never answer a switch.
const inShell = (matched: readonly RouteRecordNormalized[]): boolean => matched[0]?.path === `/`;

// A stored screen is a path or nothing; one this build no longer routes needs no separate check, the router's
// catch-all handles it like no memory at all.
const parseScreen = (raw: string): string | undefined => (raw.startsWith(`/`) ? raw : undefined);

const { activeSandboxId } = useSandbox();

// Overrides "land on the last screen" for a switch with a known destination (opening an agent from another
// sandbox's card). Recorded rather than pushed after the switch: the landing watch replaces at flush:post and
// would cancel a concurrent push.
export const landOnAfterSwitch = (sandboxId: string, path: string): void => {
    writeWindowState(screenKey(sandboxId), path);
};

// Recorded on arrival under whichever sandbox was active, so it's on file before the next switch reads it back;
// a failed navigation is not recorded, or the next switch would land on a screen the user was denied.
router.afterEach((to, _from, failure) => {
    const sandboxId = activeSandboxId.value;
    if (failure !== undefined || sandboxId === undefined || !inShell(to.matched)) {
        return;
    }
    writeWindowState(screenKey(sandboxId), to.fullPath);
});

// `replace`, not `push`, so switching sandboxes repeatedly doesn't bury Back under a stack of visits. A sandbox
// never shown lands on the shell's home. `flush: post` so useWorkspaceRoute's own pre-flush navigation wins the
// tie instead.
watch(
    activeSandboxId,
    (sandboxId) => {
        if (sandboxId === undefined || !inShell(router.currentRoute.value.matched)) {
            return;
        }
        void router.replace(readWindowState(screenKey(sandboxId), parseScreen) ?? `/`);
    },
    { flush: `post` },
);
