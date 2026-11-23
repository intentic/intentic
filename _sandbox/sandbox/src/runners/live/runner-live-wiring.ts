import type { Services } from "../../composition.js";
import { browserSessionPage, closeBrowserSession, listBrowserSessions } from "../../browser/sessions/browser-sessions.js";
import { openOwnBrowser } from "../../browser/sessions/own-browser.js";
import { dropCastdViewers } from "../../browser/media/castd.js";
import { desktopState } from "../../desktop/agent-desktop.js";
import { moveTab, reopenClosedTab, tabAction } from "../../browser/tabs/browser-tabs.js";
import { daemonListenerPorts, portRefusal } from "../../ports/port-vet.js";
import { onRuntimeChange } from "../../seams/runtime-feed.js";
import type { RunnerLiveDeps } from "./runner-live-doors.js";

// A person's stops on a card, as the local routes apply them (conversations/card-stops.routes.ts): the agent layer's, so
// handed in by main.ts rather than imported here.
export type RunnerCardStops = Pick<RunnerLiveDeps, "stopJob" | "stopWatches">;

// The runner's live-view doors over this daemon's own machinery: the functions its local routes call (system.routes.ts,
// card-stops.routes.ts, ports.routes.ts), and the revocation its netd door relays (bootstrap/netd-door.ts).
export const runnerLiveDeps = (
    services: Pick<Services, "agents" | "config" | "logger" | "mediaTickets" | "scanPorts" | "workspace" | "wsTickets">,
    stops: RunnerCardStops | undefined,
): RunnerLiveDeps => {
    // The daemon's own listeners, never previewed (ports.routes.ts).
    const reserved = daemonListenerPorts(services.config);
    return {
        subscribeRoster: (listener) => services.agents.subscribe(listener),
        onRuntimeChange: (listener) => onRuntimeChange((domains) => listener(domains), services.logger),
        browsers: () => listBrowserSessions(),
        openBrowser: (url) =>
            openOwnBrowser(
                {
                    root: services.workspace.root,
                    warn: (fields, message) => services.logger.warn(fields, message),
                    info: (fields, message) => services.logger.info(fields, message),
                },
                url,
            ),
        closeBrowser: (name) => closeBrowserSession(name),
        closeBrowserPage: async (name, pageId) => {
            await browserSessionPage(name, pageId)
                ?.close()
                // allow(silent-catch): a page or browser already gone is the close asked for
                .catch(() => undefined);
        },
        desktop: () => desktopState(),
        browserTab: async (input) => {
            switch (input.op) {
                case "reopen":
                    return await reopenClosedTab(input.name, input.closedId);
                case "move":
                    moveTab(input.name, input.pageId, input.index);
                    return {};
                case "action":
                    return await tabAction(input.name, input.pageId, input.action);
            }
        },
        // As a person's stop on a local card does, handed in from above (main.ts): nothing, before it is.
        stopJob: async (conversationId, jobId) => (await stops?.stopJob(conversationId, jobId)) ?? false,
        stopWatches: async (conversationId, watchId) => (await stops?.stopWatches(conversationId, watchId)) ?? false,
        vetPort: async (port) => portRefusal(port, await services.scanPorts(), reserved),
        revoke: async (member) => {
            // This runner signs nobody in; what it holds for the parent's people is the tickets and castd tokens their
            // views minted here, which a castd refuses from now on (castd.ts dropCastdViewers).
            services.wsTickets.revoke(member);
            services.mediaTickets.revoke(member);
            await dropCastdViewers(member === undefined ? "every member's access was revoked" : "a member's access was revoked");
        },
    };
};
