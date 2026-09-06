import { type TerminalScrollback, TerminalScrollbackSchema } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/client/sandboxClient";

/* One session's pane history, read on demand for the panel's "Full scrollback" view.
 *
 * The live tab already scrolls: an attach replays the pane's last few thousand lines into xterm (the daemon's
 * terminal/tmux-control.ts says how many) and live output grows the buffer from there. tmux keeps far more, and
 * this is how the rest is reached, everything back to the command you are looking for, as text the browser can
 * select, search and copy whole. */

// tmux keeps 100k lines per pane; asking for all of them turns a casual "show me" into tens of MB through the
// tunnel and one enormous DOM node. This is the width of the question people actually ask, and the response's
// `truncated` says when there was more behind it.
const SCROLLBACK_LINES = 20_000;

export const fetchScrollback = async (name: string): Promise<TerminalScrollback> =>
    TerminalScrollbackSchema.parse(await sandboxJson(`/system/terminals/${encodeURIComponent(name)}/scrollback?lines=${SCROLLBACK_LINES}`));
