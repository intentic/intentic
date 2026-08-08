import { dropTranscriptStore } from "./chat/transcriptCache";

/* The id of THIS build of the web app — stamped by vite.shared's define, one fresh value per build (and per
 * dev-server start). It guards the third cache axis: the daemon's hello already busts what a REPLACED WORKSPACE
 * or a REBUILT DAEMON left behind (systemEventRouting), but the web app restructures its own persisted state
 * too — a query that becomes paged changes its cached entry's shape with no daemon involved, and hydrating the
 * old shape crashed the search panel's first render. That case used to hang on a hand-bumped SCHEMA_VERSION,
 * which is to say on someone remembering; the build id is the same bump made automatic, on every build. */
export const buildId = (): string => import.meta.env.BUILD_ID ?? `dev`;

const BUILD_KEY = `intentic.build`;

/* Called once at boot, before anything opens a mirror. The vue-query mirror carries the build id in its own
 * buster (queryPersistence) and needs nothing here; the transcript mirror has no restore gate — a chat paints
 * whatever blob it finds — so a build change drops it whole. Losing it costs one fetch per reopened chat,
 * against a daemon that is the source of truth anyway. */
export const dropOutdatedMirrors = (): void => {
    let known: string | null;
    try {
        known = localStorage.getItem(BUILD_KEY);
        localStorage.setItem(BUILD_KEY, buildId());
    } catch {
        // Storage unavailable (private mode, site data off) — then nothing was ever mirrored either.
        return;
    }
    if (known !== null && known !== buildId()) {
        dropTranscriptStore();
    }
};
