import { useTheme } from "@intentic/ui/theme";
import { isRef, nextTick } from "vue";
import { buildId } from "../app/buildEpoch";
import { perfSpans, perfTable, resetPerf } from "../app/perf";
import type { RenderTrace } from "../app/renderTrace";
import { readContractFreshness, uncompiledRoutes } from "../client/sandbox/contractFreshness";
import { daemonReady } from "../client/sandbox/useDaemonBoot";
import { driftedRoutes, driftScope, missingRoutes, unknownDaemonRoutes } from "../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../client/sandbox/useSandbox";
import { THEME_ROW, type ThemeRow, themeRowLook, themeRowValue } from "../features/settings/themeRow";
import { queryClient } from "../lib/queryPersistence";
import { router } from "../router";
import { useSkin } from "../skins/useSkin";
import { commandLabel, commands, executeCommand } from "../workbench/commands/useCommands";
import { effectiveKeybinding } from "../workbench/commands/useKeymap";

// THE EDITOR, AS TOOLS AN AGENT CAN CALL. Dev servers only: main.ts installs this under import.meta.env.DEV, so a
// production build and the public demo carry none of it. WebMCP lets a page register functions for agents through
// document.modelContext; an agent driving this page in its sandbox browser finds them listed in a snapshot and calls
// them with browser_webmcp_call (the daemon's browser-router.ts). They answer what a screenshot only hints at: whose code
// the page is running, what state the app believes it is in, and the debugging handles a person types into the console.
// A browser without WebMCP (every stock one today, the owner's own included) has no modelContext and gets nothing.

interface WebMcpTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: Readonly<Record<string, unknown>>;
    readonly annotations?: { readonly readOnlyHint?: boolean };
    readonly execute: (input: Readonly<Record<string, unknown>>) => Promise<unknown>;
}

interface ModelContext {
    // Chrome answers a promise; the signal is how a tool is withdrawn.
    readonly registerTool: (tool: WebMcpTool, options?: { readonly signal?: AbortSignal }) => unknown;
}

// `document.modelContext` is the current spelling, `navigator.modelContext` the one before it.
const modelContext = (): ModelContext | undefined =>
    (document as unknown as { modelContext?: ModelContext }).modelContext ?? (navigator as unknown as { modelContext?: ModelContext }).modelContext;

const NO_INPUT = { type: `object`, properties: {} } as const;

// JSON a page tool can hand back: refs unwrapped (sandbox-scoped query keys carry one), anything unserializable named
// rather than thrown.
const plain = (value: unknown): unknown => {
    try {
        return JSON.parse(JSON.stringify(value, (_key, inner: unknown) => (isRef(inner) ? inner.value : inner)) ?? `null`) as unknown;
    } catch {
        return String(value);
    }
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const stringArg = (input: Readonly<Record<string, unknown>>, key: string): string | undefined => {
    const value = input[key];
    return typeof value === `string` && value !== `` ? value : undefined;
};

const buildTool: WebMcpTool = {
    name: `editor_build`,
    description:
        `Which checkout this page's dev server serves and which Intentic conversation started it. The editor mirrors the ` +
        `owner's own dev servers onto ports 47145 and 47146 inside the sandbox, so a page there can be the owner's code ` +
        `rather than your worktree: compare startedBy with your conversation id ($INTENTIC_TURN_OWNER) and branch with ` +
        `yours before believing what the page shows. bundle "prebundled" means the code came from the dev server's ` +
        `optimizer cache, which a reload can serve from before your latest edits.`,
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => ({
        ...(import.meta.env.DEV_SOURCE ?? { root: null, branch: null, startedBy: null, startedAt: null }),
        buildId: buildId(),
        bundle: import.meta.url.includes(`/.vite/deps/`) ? `prebundled` : `source`,
        app: import.meta.env.BASE_URL === `/demo/` ? `demo` : `editor`,
        url: location.href,
    }),
};

const stateTool: WebMcpTool = {
    name: `editor_state`,
    description:
        `What the editor believes right now: its route, its connection to the active sandbox, whether the sandbox and this ` +
        `app disagree about the contract between them, and every data request currently failing with its error.`,
    inputSchema: NO_INPUT,
    annotations: { readOnlyHint: true },
    execute: async () => {
        const { activeSandboxId, active, connection, reachable } = useSandbox();
        // Asked only when something disagrees, as the app itself does: it costs the dev server a contract load.
        if (driftedRoutes.value.length > 0) {
            await readContractFreshness();
        }
        const route = router.currentRoute.value;
        return {
            route: { path: route.fullPath, name: route.name === undefined ? null : String(route.name), params: plain(route.params) },
            sandbox: {
                id: activeSandboxId.value ?? null,
                name: active.value?.name ?? null,
                connection: connection.value.phase,
                failure: connection.value.failure ?? null,
                attempt: connection.value.attempt,
                everOnline: connection.value.everOnline,
                reachable: reachable.value,
                daemonReady: daemonReady.value,
            },
            contract: {
                scope: driftScope.value,
                sandboxLacks: missingRoutes.value,
                appLacks: unknownDaemonRoutes.value,
                shapedDifferently: driftedRoutes.value,
                uncompiledInThisCheckout: uncompiledRoutes.value,
            },
            failingRequests: queryClient
                .getQueryCache()
                .getAll()
                .filter((query) => query.state.status === `error`)
                .map((query) => ({
                    key: plain(query.queryKey),
                    error: errorText(query.state.error),
                    failures: query.state.fetchFailureCount,
                    at: new Date(query.state.errorUpdatedAt).toISOString(),
                })),
        };
    },
};

const lookTool = (): WebMcpTool => {
    const { choice: schemeChoice, set: setScheme } = useTheme();
    const { skin, choice: skinChoice, setSkin } = useSkin();
    return {
        name: `editor_look`,
        description:
            `Read or set the editor's look, as the Appearance setting does: system, light, dark or sanctum. Applies live, ` +
            `no reload. Answers the look worn and the attributes and canvas colour it resolved to, which are the truth to ` +
            `check a screenshot against. Omit look to only read it.`,
        inputSchema: { type: `object`, properties: { look: { type: `string`, enum: THEME_ROW } } },
        execute: async (input) => {
            const look = stringArg(input, `look`);
            if (look !== undefined) {
                if (!THEME_ROW.includes(look as ThemeRow)) {
                    throw new Error(`look is one of ${THEME_ROW.join(`, `)}`);
                }
                const pair = themeRowLook(look as ThemeRow);
                // The skin first, as the Appearance row does: pinning sanctum drags the scheme dark with it.
                setSkin(pair.skin);
                setScheme(pair.scheme);
                await nextTick();
            }
            const root = document.documentElement;
            return {
                look: themeRowValue(schemeChoice.value, skinChoice.value, skin.value),
                mode: root.getAttribute(`data-mode`),
                skin: root.getAttribute(`data-skin`),
                canvas: getComputedStyle(root).getPropertyValue(`--color-canvas`).trim(),
            };
        },
    };
};

const commandTool: WebMcpTool = {
    name: `editor_command`,
    description:
        `Run one of the editor's commands by id, as the command palette does (with no arguments): navigation, opening ` +
        `panels, toggles. Omit command to list every command registered right now, with its label and keybinding; ` +
        `some register only while the view that owns them is on screen.`,
    inputSchema: { type: `object`, properties: { command: { type: `string`, description: `A command id from the list` } } },
    execute: async (input) => {
        const command = stringArg(input, `command`);
        if (command === undefined) {
            // Id to label, the keybinding in brackets: one line a command, which a list of sixty-odd needs.
            return {
                commands: Object.fromEntries(
                    commands.value.map((entry) => {
                        const chord = effectiveKeybinding(entry.command, entry.keybinding);
                        return [entry.command, chord === undefined ? commandLabel(entry) : `${commandLabel(entry)} [${chord}]`];
                    }),
                ),
            };
        }
        // No route in the answer: a navigation a command starts lands after it returns, and the browser tool's own
        // answer already carries the page's address once it has.
        const result = await executeCommand(command);
        return { ran: command, result: result === undefined ? null : plain(result) };
    },
};

// Bounds what one answer carries: the ring holds a thousand spans.
const SPAN_LIMIT = 100;
const ROW_LIMIT = 40;

const perfTool: WebMcpTool = {
    name: `editor_perf`,
    description:
        `The editor's own timing spans (what __intenticPerf prints). table: every op ranked by total time, the top row ` +
        `is the bottleneck. spans: the latest spans, newest last, optionally only ops starting with prefix. reset: zero ` +
        `both before reproducing something deliberately.`,
    inputSchema: {
        type: `object`,
        properties: { action: { type: `string`, enum: [`table`, `spans`, `reset`] }, prefix: { type: `string` } },
        required: [`action`],
    },
    execute: async (input) => {
        switch (stringArg(input, `action`)) {
            case `table`:
                return { rows: perfTable().slice(0, ROW_LIMIT) };
            case `spans`:
                return { spans: perfSpans(stringArg(input, `prefix`)).slice(-SPAN_LIMIT) };
            case `reset`:
                resetPerf();
                return { reset: true };
            default:
                throw new Error(`action is table, spans or reset`);
        }
    },
};

// A cause's stack is kept whole for the console; the frames nearest the write are the ones worth reading.
const STACK_FRAMES = 8;

const renderTool = (render: RenderTrace): WebMcpTool => ({
    name: `editor_render`,
    description:
        `Why components redraw (what __intenticRender records). on: start recording, then reproduce the interaction. ` +
        `table: redraws per component, worst first, with the reactive write behind most of them. why: every write that ` +
        `woke one component, named in component. off: stop and clear.`,
    inputSchema: {
        type: `object`,
        properties: { action: { type: `string`, enum: [`on`, `off`, `table`, `why`] }, component: { type: `string` } },
        required: [`action`],
    },
    execute: async (input) => {
        switch (stringArg(input, `action`)) {
            case `on`:
                render.on();
                return { recording: true };
            case `off`:
                render.off();
                return { recording: false };
            case `table`:
                return { rows: render.rows().slice(0, ROW_LIMIT) };
            case `why`: {
                const component = stringArg(input, `component`);
                if (component === undefined) {
                    throw new Error(`why needs component: a name from the table`);
                }
                return { causes: render.why(component).slice(0, ROW_LIMIT).map((cause) => ({ ...cause, stack: cause.stack.slice(0, STACK_FRAMES) })) };
            }
            default:
                throw new Error(`action is on, off, table or why`);
        }
    },
});

// A tool that throws reaches the agent as Chrome's "the invocation failed" and nothing else; answered instead, the
// sentence arrives, and `isError` is how @playwright/mcp tells the agent it is one.
const answeringErrors = (tool: WebMcpTool): WebMcpTool => ({
    ...tool,
    execute: async (input) => {
        try {
            return await tool.execute(input);
        } catch (error) {
            return { isError: true, error: errorText(error) };
        }
    },
});

/** Registers the editor's agent tools on a page that has WebMCP; does nothing on one that doesn't. */
export const installAgentDevTools = (render: RenderTrace): void => {
    const context = modelContext();
    if (context === undefined) {
        return;
    }
    for (const tool of [buildTool, stateTool, lookTool(), commandTool, perfTool, renderTool(render)].map(answeringErrors)) {
        // A refused registration costs that one tool, not the page.
        void (async () => await context.registerTool(tool))().catch((error: unknown) => console.warn(`[webmcp] ${tool.name}: ${errorText(error)}`));
    }
};
