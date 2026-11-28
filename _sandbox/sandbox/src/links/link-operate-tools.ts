import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { type FarOperate, farOperateTools } from "../s2s/calls/far-operate-tools.js";
import { linkExec, linkExecStatus, linkExecStop, linkFileRead, linkFileWrite, type LinkTarget } from "../sandboxes/link-client.js";

// OPERATING A LINKED SANDBOX, the asking side (schemas/links.ts `operate`): `run_command`, `read_file` and `write_file`
// on the link's tool server, beside `delegate`. The tools are the ones a contact's server carries too
// (s2s/calls/far-operate-tools.ts); here they reach the far side through the link card's operating doors. The far side
// decides whether the link may operate it; this side only keeps a turn that may not hand work on from operating another
// sandbox either.

type LinkCard = Extract<Capability, { kind: "link" }>;

/** The link card's operating doors, as the tools reach them. */
const linkOperate = (target: LinkTarget): FarOperate => ({
    exec: (exec, signal) => linkExec(target, exec, signal),
    status: (id, waitS, signal) => linkExecStatus(target, id, waitS, signal),
    stop: (id) => linkExecStop(target, id),
    read: (read, signal) => linkFileRead(target, read, signal),
    write: (write, signal) => linkFileWrite(target, write, signal),
});

/** The operating tools of one linked sandbox's server; `may` says whether this turn may act on another sandbox at all. */
export const operateTools = (card: LinkCard, sandbox: string, conversationId: string | undefined, may: () => boolean) =>
    farOperateTools(
        linkOperate({ id: card.id, config: card.config }),
        {
            sandbox,
            title: `the linked sandbox "${sandbox}"`,
            allowed: `Only while "${sandbox}"'s owner lets this link operate it (\`about\` says whether); every call is logged over there.`,
        },
        conversationId,
        may,
    );
