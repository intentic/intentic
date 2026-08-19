// @vitest-environment jsdom
//
// jsdom because the subject is the app's real key builders, and reaching them pulls in composables that touch
// browser globals at import time. The rule itself is one predicate; what is worth pinning is that the three
// heavy reads actually carry the mark, which can only be asserted against the builders themselves.
import { describe, expect, it, vi } from "vitest";
import { mirrors, UNPERSISTED } from "./queryPersistence";
// Statically imported, not awaited inside a hook: these builders' graph is app-wide, and compiling it cold on a
// runner with every core busy takes longer than a hook is allowed to (vitest's hookTimeout) — the same work at
// import time is simply the file's load, paid during collection. The globals below still land first; vi.hoisted
// runs above every import in the transformed module, which is exactly what it is for.
import { agentTranscriptKey } from "./chat/agentTranscript";
import { agentFileDiffKey } from "./agents/useAgentChanges";
import { changesKey, fileDiffKey } from "./workspace/useChanges";

// The key builders' import chain pulls in app-wide singletons that read browser globals at import time
// (@intentic/ui's useDevice reads window.matchMedia; environment.ts reads window.env).
vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

/* THE STORAGE RULE, ASSERTED.
 *
 * The query cache is mirrored to disk WHOLE — one structured clone of everything the app has ever cached, per
 * write — so a single megabyte-scale entry that slips into it is charged to every other write for the rest of
 * the session, and shows up as the app stuttering every couple of seconds while apparently doing nothing. The
 * marker on the key is what keeps such an entry out, and a marker is exactly the kind of thing that gets
 * dropped in a refactor by someone who has no way to know what it was for.
 *
 * Now that a background loader fills this cache on the app's behalf rather than only the screen in front of the
 * user, the volume is no longer bounded by what someone clicked — which is what makes this worth a test rather
 * than a comment. */

const keys = {
    workingDiff: fileDiffKey(`root`, `src/app.ts`, `unstaged`),
    agentDiff: agentFileDiffKey(`agent-1`, `root`, `src/app.ts`),
    transcript: agentTranscriptKey(`agent-1`),
    changes: changesKey(),
};

describe(`what may go to disk`, () => {
    it(`keeps a working-tree file diff out — two whole file texts, one per changed file`, () => {
        expect(keys.workingDiff).toContain(UNPERSISTED);
        expect(mirrors(keys.workingDiff)).toBe(false);
    });

    it(`keeps an agent's file diff out, on exactly the same terms`, () => {
        expect(keys.agentDiff).toContain(UNPERSISTED);
        expect(mirrors(keys.agentDiff)).toBe(false);
    });

    it(`keeps a conversation transcript out — it has a per-record store of its own`, () => {
        expect(keys.transcript).toContain(UNPERSISTED);
        expect(mirrors(keys.transcript)).toBe(false);
    });

    it(`still mirrors the small, shape-stable lists a reload has to paint from`, () => {
        expect(mirrors(keys.changes)).toBe(true);
        expect(mirrors([`workspace`, `tree`, `shared`, `sandbox-1`])).toBe(true);
    });

    it(`never mirrors a sandbox row, which carries the tunnel's connect token`, () => {
        expect(mirrors([`sandbox`, `list`])).toBe(false);
    });
});
