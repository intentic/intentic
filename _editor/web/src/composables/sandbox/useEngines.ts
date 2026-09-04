import { type EngineRow, type EnginesView, EnginesViewSchema } from "@intentic-app/api-contract";
import type { NoticeModel } from "@intentic/ui";
import { computed, onScopeDispose, ref, watch } from "vue";
import { ENGINES } from "../queryKeys";
import { queryClient } from "../queryPersistence";
import { jsonBody } from "./jsonBody";
import { sandboxJson } from "./sandboxClient";
import { useSandboxQuery } from "./useSandboxQuery";

/* THE AGENT ENGINES this sandbox runs — the Claude Code CLI and its SDK, codex, the Cursor SDK, opencode, the
 * subscription translator — and which version of each is on.
 *
 * Read from the daemon's /engines route. Every row carries where its version came from (the image, or the
 * store on the daemon's volume), what its channel would move it to, and what going back would mean, because
 * "which Claude Code is this sandbox on" stopped being a property of the image the day these became
 * installable at runtime.
 *
 * In-flight states live at module scope so switching between tabs or views in the app does not drop
 * which engines are currently installing, reverting, or updating in the background. */

export const ENGINES_KEY = ENGINES.of();

const inFlight = ref<Map<string, "update" | "revert" | "channel">>(new Map());
const updatingAll = ref(false);
const actionNotice = ref<NoticeModel | undefined>();

const setInFlight = (id: string, action: "update" | "revert" | "channel") => {
    const next = new Map(inFlight.value);
    next.set(id, action);
    inFlight.value = next;
};

const clearInFlight = (id: string) => {
    const next = new Map(inFlight.value);
    next.delete(id);
    inFlight.value = next;
};

const postAction = async (path: string, body: object, fallbackMessage: string): Promise<void> => {
    try {
        const answer = (await sandboxJson(path, jsonBody(`POST`, body))) as { engines: unknown };
        queryClient.setQueryData(ENGINES_KEY, EnginesViewSchema.parse(answer.engines));
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : fallbackMessage;
        actionNotice.value =
            message === `not a sandbox maintainer`
                ? { tone: `warning`, title: `Only a sandbox maintainer can change which agent engines this sandbox runs.` }
                : { tone: `danger`, title: message };
        throw err;
    }
};

export const setEngineChannel = async (
    engine: EngineRow,
    kind: "blessed" | "latest" | "pinned" | "image",
): Promise<void> => {
    setInFlight(engine.id, "channel");
    actionNotice.value = undefined;
    try {
        if (kind === "pinned" && engine.running.version === undefined) {
            await postAction(`/engines/channel`, { id: engine.id, kind: "image" }, `Could not change ${engine.label} version source.`);
        } else {
            await postAction(
                `/engines/channel`,
                { id: engine.id, kind, ...(kind === "pinned" ? { version: engine.running.version } : {}) },
                `Could not change ${engine.label} version source.`,
            );
        }
    } finally {
        clearInFlight(engine.id);
    }
};

export const updateEngine = async (engine: EngineRow): Promise<void> => {
    setInFlight(engine.id, "update");
    actionNotice.value = undefined;
    try {
        await postAction(`/engines/update`, { id: engine.id }, `Could not update ${engine.label}.`);
    } finally {
        clearInFlight(engine.id);
    }
};

export const revertEngine = async (engine: EngineRow): Promise<void> => {
    setInFlight(engine.id, "revert");
    actionNotice.value = undefined;
    try {
        await postAction(`/engines/revert`, { id: engine.id }, `Could not revert ${engine.label}.`);
    } finally {
        clearInFlight(engine.id);
    }
};

export const updateAllEngines = async (): Promise<void> => {
    if (updatingAll.value) {
        return;
    }
    const currentView = queryClient.getQueryData<EnginesView>(ENGINES_KEY);
    const targets = (currentView?.engines ?? []).filter((e) => e.offered !== undefined);
    if (targets.length === 0) {
        return;
    }
    updatingAll.value = true;
    actionNotice.value = undefined;
    for (const engine of targets) {
        setInFlight(engine.id, "update");
    }
    try {
        for (const engine of targets) {
            try {
                await postAction(`/engines/update`, { id: engine.id }, `Could not update ${engine.label}.`);
            } catch {
                // Carry on with next engine so one failure doesn't halt the whole queue
            } finally {
                clearInFlight(engine.id);
            }
        }
    } finally {
        updatingAll.value = false;
    }
};

export function useEngines() {
    const { query } = useSandboxQuery({
        queryKey: ENGINES_KEY,
        queryFn: async () => EnginesViewSchema.parse(await sandboxJson(`/engines`)),
    });
    const view = computed<EnginesView | undefined>(() => query.data.value);
    const engines = computed<readonly EngineRow[]>(() => view.value?.engines ?? []);

    // A boolean rather than the ref, for the reason useEnvironment spells out: reaching through vue-query's
    // object in a template does not unwrap, so a refresh icon bound to it spins forever.
    const isFetching = computed<boolean>(() => query.isFetching.value);

    // Rows with something waiting. What the card's badge counts, and the reason it is derived here rather than
    // in the template: the shell's own banner asks the same question.
    const updatable = computed<readonly EngineRow[]>(() => engines.value.filter((engine: EngineRow) => engine.offered !== undefined));

    const anyInstalling = computed<boolean>(
        () => engines.value.some((engine: EngineRow) => engine.installing) || inFlight.value.size > 0 || updatingAll.value,
    );

    let pollTimer: ReturnType<typeof setInterval> | undefined;
    watch(
        anyInstalling,
        (active) => {
            if (active) {
                if (pollTimer === undefined) {
                    pollTimer = setInterval(() => {
                        void query.refetch();
                    }, 1500);
                }
            } else if (pollTimer !== undefined) {
                clearInterval(pollTimer);
                pollTimer = undefined;
            }
        },
        { immediate: true },
    );

    onScopeDispose(() => {
        if (pollTimer !== undefined) {
            clearInterval(pollTimer);
            pollTimer = undefined;
        }
    });

    const isEngineUpdating = (engine: EngineRow): boolean =>
        engine.installing === true ||
        inFlight.value.get(engine.id) === "update" ||
        (updatingAll.value && engine.offered !== undefined);

    const isEngineReverting = (engine: EngineRow): boolean => inFlight.value.get(engine.id) === "revert";

    const isEngineBusy = (engine: EngineRow): boolean =>
        isEngineUpdating(engine) || isEngineReverting(engine) || inFlight.value.has(engine.id);

    const isAnyBusy = computed<boolean>(
        () => isFetching.value || inFlight.value.size > 0 || updatingAll.value || engines.value.some((e: EngineRow) => e.installing),
    );

    return {
        view,
        engines,
        updatable,
        query,
        isFetching,
        isAnyBusy,
        updatingAll,
        actionNotice,
        isEngineUpdating,
        isEngineReverting,
        isEngineBusy,
        setChannel: setEngineChannel,
        update: updateEngine,
        revert: revertEngine,
        updateAll: updateAllEngines,
    };
}

