// This build's id, stamped by vite.shared's define, fresh per build or dev-server start. Busts the web app's own
// persisted-state cache when its shape changes, automatically, unlike a hand-bumped SCHEMA_VERSION.
export const buildId = (): string => import.meta.env.BUILD_ID ?? `dev`;

const BUILD_KEY = `intentic.build`;

// Called once at boot, before any mirror opens. The vue-query mirror busts itself (queryPersistence); a mirror with no
// restore gate paints whatever it finds, so a build change must drop it whole: `drop` does, handed in by main.ts (the
// chat's transcript mirror, at the cost of one refetch against the daemon) since those mirrors sit above this module.
export const dropOutdatedMirrors = (drop: () => void): void => {
    let known: string | null;
    try {
        known = localStorage.getItem(BUILD_KEY);
        localStorage.setItem(BUILD_KEY, buildId());
    } catch {
        // Storage unavailable (private mode, site data off), then nothing was ever mirrored either.
        return;
    }
    if (known !== null && known !== buildId()) {
        drop();
    }
};
