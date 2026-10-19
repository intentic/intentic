import { engineIsolationOf } from "./engine-isolation.js";

const root = `C:\\Users\\ci\\Temp\\intentic-engine-smoke`;

test(`both smoke fixtures and their parked copies belong to the tier; other sandboxes do not`, () => {
    const containers = [`winengine`, `winsmoke`, `winengine.moved`, `winsmoke.previous`, `runner-omen`].map((slug) => ({
        Name: `/intentic-sandbox-${slug}`, Mounts: [],
    }));
    expect(engineIsolationOf(containers, root)).toEqual({ unexpected: [`intentic-sandbox-runner-omen`], homeUsers: [] });
});

test(`cleanup preserves every other container's bind into the home, in each engine's Windows path spelling`, () => {
    for (const prefix of [`C:/`, `c:\\`, `/mnt/c/`, `/run/desktop/mnt/host/c/`, `/host_mnt/c/`, `/c/`]) {
        const source = `${prefix}Users/ci/Temp/intentic-engine-smoke/home/.intentic/keys/key`;
        expect(engineIsolationOf([
            { Name: `/intentic-sandbox-runner-omen`, Mounts: [{ Type: `bind`, Source: source }] },
            { Name: `/another-app`, Mounts: [{ Type: `bind`, Source: source }] },
        ], root)).toEqual({ unexpected: [`intentic-sandbox-runner-omen`], homeUsers: [`intentic-sandbox-runner-omen`, `another-app`] });
    }
});

test(`the root itself counts, sibling paths and named volumes do not`, () => {
    expect(engineIsolationOf([
        { Name: `/at-root`, Mounts: [{ Type: `bind`, Source: root.toUpperCase() }] },
        { Name: `/sibling`, Mounts: [{ Type: `bind`, Source: `${root}-other/home/key` }] },
        { Name: `/volume`, Mounts: [{ Type: `volume`, Source: `${root}/volume` }] },
        { Name: `/intentic-sandbox-winengine`, Mounts: [{ Type: `bind`, Source: `${root}/home/key` }] },
    ], root)).toEqual({ unexpected: [], homeUsers: [`at-root`] });
});
