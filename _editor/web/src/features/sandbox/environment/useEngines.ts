import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import type { EngineRow, EnginesView, EngineWriteResult, RawJsonInput } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { computed } from "vue";
import { ENGINES } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { t } from "@intentic/ui/i18n";

// The agent engines this sandbox runs (Claude Code, codex, Cursor SDK, opencode, ...) and which version each is on,
// read from the daemon's /engines route. In-flight update/revert/channel state lives at module scope, so switching tabs
// doesn't drop what's mid-flight; a switch of sandbox does, since those engines are the other box's.
// Never polled: the daemon's `engines` push lands every install's start and end, whoever started it.

export const ENGINES_KEY = ENGINES.of();

const inFlight = sandboxRef<Map<string, "update" | "revert" | "channel">>(() => new Map());
const updatingAll = sandboxRef(() => false);
const actionNotice = sandboxRef<NoticeModel | undefined>(() => undefined);

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

// An answer after a switch describes the box left behind: it is filed nowhere, and says nothing here.
type EngineWrite = `POST /engines/channel` | `POST /engines/update` | `POST /engines/revert`;
const postAction = async <Key extends EngineWrite>(key: Key, input: RawJsonInput<Key>, fallbackMessage: string): Promise<void> => {
    const current = sandboxScopeGuard();
    try {
        const answer: EngineWriteResult = await sandboxRaw(key, { input });
        if (current()) {
            queryClient.setQueryData(ENGINES_KEY, answer.engines);
        }
    } catch (err: unknown) {
        if (!current()) {
            throw err;
        }
        const message = err instanceof Error ? err.message : fallbackMessage;
        actionNotice.value =
            message === `not a sandbox maintainer`
                ? { tone: `warning`, title: t(`sandbox.useEngines.onlySandboxMaintainerChange`) }
                : { tone: `danger`, title: message };
        throw err;
    }
};

export const setEngineChannel = async (engine: EngineRow, kind: "blessed" | "latest" | "pinned" | "image"): Promise<void> => {
    setInFlight(engine.id, "channel");
    actionNotice.value = undefined;
    try {
        if (kind === "pinned" && engine.running.version === undefined) {
            await postAction(`POST /engines/channel`, { id: engine.id, kind: "image" }, `Could not change ${engine.label} version source.`);
        } else {
            await postAction(
                `POST /engines/channel`,
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
        await postAction(`POST /engines/update`, { id: engine.id }, `Could not update ${engine.label}.`);
    } finally {
        clearInFlight(engine.id);
    }
};

export const revertEngine = async (engine: EngineRow): Promise<void> => {
    setInFlight(engine.id, "revert");
    actionNotice.value = undefined;
    try {
        await postAction(`POST /engines/revert`, { id: engine.id }, `Could not revert ${engine.label}.`);
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
                await postAction(`POST /engines/update`, { id: engine.id }, `Could not update ${engine.label}.`);
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
        queryFn: () => sandboxRaw(`GET /engines`),
    });
    const view = computed<EnginesView | undefined>(() => query.data.value);
    const engines = computed<readonly EngineRow[]>(() => view.value?.engines ?? []);

    // A boolean, not the ref: reaching through vue-query's object in a template doesn't unwrap it (see useEnvironment).
    const isFetching = computed<boolean>(() => query.isFetching.value);
    const isLoading = computed<boolean>(() => query.isLoading.value);

    // Rows with an update waiting; derived here since the shell's own banner counts the same thing.
    const updatable = computed<readonly EngineRow[]>(() => engines.value.filter((engine: EngineRow) => engine.offered !== undefined));

    const isEngineUpdating = (engine: EngineRow): boolean =>
        engine.installing === true || inFlight.value.get(engine.id) === "update" || (updatingAll.value && engine.offered !== undefined);

    const isEngineReverting = (engine: EngineRow): boolean => inFlight.value.get(engine.id) === "revert";

    const isEngineBusy = (engine: EngineRow): boolean => isEngineUpdating(engine) || isEngineReverting(engine) || inFlight.value.has(engine.id);

    const isAnyBusy = computed<boolean>(
        () => isFetching.value || inFlight.value.size > 0 || updatingAll.value || engines.value.some((e: EngineRow) => e.installing),
    );

    return {
        view,
        engines,
        updatable,
        query,
        isFetching,
        isLoading,
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
