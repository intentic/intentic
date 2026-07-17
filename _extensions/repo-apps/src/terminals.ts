import { TerminalsListSchema } from "@intentic/sandbox-contract";
import { host } from "./host";

// The daemon's tmux session list (web-* shells + panel-* dev servers + one-shot jobs) — used to watch a
// one-shot add/test session's `running` flag. Via the host transport; failures bubble to the caller.
export const listTerminals = async (): Promise<{ name: string; running: boolean }[]> =>
    TerminalsListSchema.parse(await host().sandbox.json(`/system/terminals`)).sessions.map(({ name, running }) => ({ name, running }));
