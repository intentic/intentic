import { type TerminalScrollback, TerminalScrollbackSchema } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/client/sandboxClient";

/* One session's pane history, read on demand for the panel's "Full scrollback" view. */

// tmux keeps 100k lines per pane; asking for all of them turns a casual "show me" into tens of MB through the
// tunnel and one enormous DOM node. This is the width of the question people actually ask, and the response's
// `truncated` says when there was more behind it.
const SCROLLBACK_LINES = 20_000;

export const fetchScrollback = async (name: string): Promise<TerminalScrollback> =>
    TerminalScrollbackSchema.parse(await sandboxJson(`/system/terminals/${encodeURIComponent(name)}/scrollback?lines=${SCROLLBACK_LINES}`));
