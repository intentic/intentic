import type { ViewAsk, ViewRegistration } from "@intentic/extension-api";

// What each registered view says a person owes it, gathered for the Needs you inbox. core-views/registry wires the
// gatherer at load; the inbox reads through here so it never imports core-views, which would close
// needs → core-views → shell → needs.

export interface ViewAsks {
    readonly view: ViewRegistration;
    readonly asks: readonly ViewAsk[];
}

let gather: () => readonly ViewAsks[] = () => [];

export const registerViewAsksGatherer = (fn: () => readonly ViewAsks[]): void => {
    gather = fn;
};

export const viewAsks = (): readonly ViewAsks[] => gather();
