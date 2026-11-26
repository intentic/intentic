import { errorMessage } from "@intentic/base/errors";
import { CAPABILITY_KIND_TRAITS } from "@intentic/sandbox-contract/policy/capabilities/capability-kinds";
import type { Services } from "../../composition.js";
import { browserOutputDir } from "../cast/browser-artifacts.js";
import { toolCallIdOf, writeScreenshotProvenance } from "../cast/screenshot-provenance.js";
import { browserAccountPage } from "../sessions/browser-sessions.js";
import { profileOwner } from "../sessions/session-store.js";
import { type BrowserRouterFactory, createBrowserRouter, type Prepared, type RouterCastd, type RouterDeps } from "./browser-router.js";
import { displayOf } from "../cast/display.js";
import { readRegion } from "../cast/region.js";
import { castdControlOf, castdPause, castdScreenshot } from "../media/agent-capture.js";
import { type TurnRecordingDeps, turnBrowsed, turnEnded } from "../media/agent-recording.js";
import { keepRecording, pruneTurnRecordings } from "../media/recordings.js";
import { castdOf, ensureCastd } from "../media/castd.js";
import { ANONYMOUS_BROWSER_SERVER, browserToolSchemas, prepareBrowserOwner } from "./browser-tools.js";

// The daemon's side of every turn's browser routers: bringing one owner up on the first call that names it. The routers
// run here rather than as a process per session since display allocation, fingerprints, exits and profile locks are all
// this process's state anyway.

// Second gate, not the only one: a turn's manifest already limits which owners its router may ask for, and this limits
// the ask to profiles the sandbox actually holds, so no manifest can name a path.
export const prepareKnownOwner = async (services: Pick<Services, "capabilities" | "workspace">, owner: string, port: number): Promise<Prepared> => {
    const capabilities = await services.capabilities.list();
    const known =
        owner === ANONYMOUS_BROWSER_SERVER ||
        capabilities.some((capability) => CAPABILITY_KIND_TRAITS[capability.kind].sandboxBrowser && profileOwner(capability) === owner);
    if (!known) {
        return { refusal: `no browser profile named "${owner}" in this sandbox` };
    }
    return prepareBrowserOwner(capabilities, services.workspace.root, owner, port);
};

// `turnNotice` writes a notice into a conversation's running turn: the composition fills it, since a turn is above the
// browser's layer.
type RouterServices = Pick<Services, "capabilities" | "workspace"> &
    Partial<Pick<Services, "logger" | "sandboxSettings">> & { readonly turnNotice?: (conversationId: string, text: string) => void };

// What a turn's recording reaches (media/agent-recording.ts): the sandbox's switch, the conversation's transcript, and
// the owner's window, castd started cropped to it where nobody watches it yet.
const turnRecording = (services: () => RouterServices): TurnRecordingDeps => ({
    // allow(silent-catch): settings that cannot be read leave the switch at its default, off.
    enabled: async () => (await services().sandboxSettings?.get().catch(() => undefined))?.recordAgentBrowsing === true,
    outputDir: browserOutputDir(services().workspace.root),
    note: (conversationId, text) => services().turnNotice?.(conversationId, text),
    log: (fields, message) => services().logger?.info(fields, message),
    // The castd already serving the window's display, however framed (a person's view of it, as its screen): ensuring a
    // crop over it would end that castd, and the person's picture with it.
    castd: (owner, display, rect) => {
        const running = castdOf(owner);
        return running?.display === display.name
            ? running
            : ensureCastd({ key: owner, display: display.name, framing: { kind: "crop", rect }, maxSize: { width: display.width, height: display.height } });
    },
    display: displayOf,
    page: browserAccountPage,
    region: async (page, display) => (await readRegion(page, { width: display.width, height: display.height }))?.region,
    now: () => new Date(),
    keep: async (file, recorded) => {
        await keepRecording(file, recorded);
        await pruneTurnRecordings(browserOutputDir(services().workspace.root));
    },
});

// What a turn's browser calls take off castd where the window has one: its screenshots, its pauses, its recording.
const routerCastd = (services: () => RouterServices): RouterCastd => {
    const recording = turnRecording(services);
    return {
        screenshot: (owner, params) => castdScreenshot(owner, params, browserOutputDir(services().workspace.root)),
        pause: (owner, seconds) => castdPause(castdControlOf(owner), seconds),
        browsed: (owner, conversationId) => {
            if (conversationId !== undefined) {
                void turnBrowsed(owner, conversationId, recording);
            }
        },
        closed: (conversationId) => {
            if (conversationId !== undefined) {
                void turnEnded(conversationId, recording);
            }
        },
    };
};

// Every turn's router is made here and mounted by the turn (browser-tools.ts), which reaches it at the daemon's one MCP
// door. Services are read lazily, since the factory is one of them.
// `logger` is optional only so a caller handing just the two stores still compiles; without it a sidecar that failed
// is said nowhere.
export const createBrowserRouters = (services: () => RouterServices): BrowserRouterFactory => {
    const deps: RouterDeps = {
        toolSchemas: browserToolSchemas,
        prepare: (owner, port) => prepareKnownOwner(services(), owner, port),
        // A sidecar that could not be written costs the shot nothing; the agent already has its answer.
        screenshotTaken: (shot) => {
            void writeScreenshotProvenance({
                outputDir: browserOutputDir(services().workspace.root),
                browser: shot.owner,
                answer: shot.answer,
                conversationId: shot.conversationId,
                toolCallId: toolCallIdOf(shot.params),
                page: browserAccountPage(shot.owner),
            }).catch((error: unknown) =>
                services().logger?.warn({ conversationId: shot.conversationId, reason: errorMessage(error) }, "browser: screenshot provenance not written"),
            );
        },
    };
    // The output dir read per router, not once here: the workspace is one of the services still being composed when this
    // factory is made.
    return (manifest) => {
        const { root } = services().workspace;
        return createBrowserRouter(manifest, {
            ...deps,
            outputDir: browserOutputDir(root),
            castd: routerCastd(services),
        });
    };
};
