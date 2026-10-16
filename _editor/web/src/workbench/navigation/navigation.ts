import type { Router } from "vue-router";

// The app's one router, for whatever below the route table navigates or reads the current route: the route table hands it
// in where it creates it (router/index.ts), so nothing below composition imports the table and every view it names.
let installed: Router | undefined;
// Work registered at module scope before the route table ran (an afterEach hook, a watch that replaces the route), run
// in the order it came once the router is in.
const pending: ((router: Router) => void)[] = [];

export const installNavigation = (router: Router): void => {
    installed = router;
    for (const run of pending.splice(0)) {
        run(router);
    }
};

export const navigation = (): Router => {
    if (installed === undefined) {
        throw new Error(`navigation() before the route table installed the router (router/index.ts)`);
    }
    return installed;
};

// Runs `run` with the router now if it is installed, or as soon as it is.
export const onNavigation = (run: (router: Router) => void): void => {
    if (installed === undefined) {
        pending.push(run);
        return;
    }
    run(installed);
};
