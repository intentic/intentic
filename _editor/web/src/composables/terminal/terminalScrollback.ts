import { type TerminalScrollback, TerminalScrollbackSchema } from "@intentic/sandbox-contract";
import { sandboxJson } from "../sandbox/sandboxClient";

/* One session's pane history, read on demand for the panel's "Full scrollback" view.
 *
 * A separate read rather than anything the live terminal already holds, because a tmux client runs on the
 * ALTERNATE screen: the wheel scrolls tmux's own pane history, on the far side of the socket, and none of it
 * ever enters the xterm buffer the page could select from. The grid can therefore only ever give you the
 * screenful in front of you — "scroll back and copy that" has no answer there, and has one here, as text the
 * browser can select, search and copy whole. */

// tmux keeps 100k lines per pane; asking for all of them turns a casual "show me" into tens of MB through the
// tunnel and one enormous DOM node. This is the width of the question people actually ask — everything back to
// the command they are looking for — and the response's `truncated` says when there was more behind it.
const SCROLLBACK_LINES = 20_000;

export const fetchScrollback = async (name: string): Promise<TerminalScrollback> =>
    TerminalScrollbackSchema.parse(await sandboxJson(`/system/terminals/${encodeURIComponent(name)}/scrollback?lines=${SCROLLBACK_LINES}`));
