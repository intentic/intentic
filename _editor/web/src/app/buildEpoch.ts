import { dropTranscriptStore } from "../features/chat/transcript/transcriptCache";

// This build's id, stamped by vite.shared's define, fresh per build or dev-server start. Busts the web app's own
// persisted-state cache when its shape changes, automatically, unlike a hand-bumped SCHEMA_VERSION.
export const buildId = (): string => import.meta.env.BUILD_ID ?? `dev`;

const BUILD_KEY = `intentic.build`;

// Called once at boot, before any mirror opens. The vue-query mirror busts itself (queryPersistence); the
// transcript mirror has no restore gate and paints whatever it finds, so a build change must drop it whole (costs
// one refetch against the daemon).
export const dropOutdatedMirrors = (): void => {
    let known: string | null;
    try {
        known = localStorage.getItem(BUILD_KEY);
        localStorage.setItem(BUILD_KEY, buildId());
    } catch {
        // Storage unavailable (private mode, site data off), then nothing was ever mirrored either.
        return;
    }
    if (known !== null && known !== buildId()) {
        dropTranscriptStore();
    }
};
