import { edTarget, ezdTarget } from "../actions.js";
import { edFromEnv, ezdFromEnv, pickCard } from "../core/cards.js";
import { ActionGuard, type Operation } from "../core/guard.js";
import { OfficeRecords } from "../core/records.js";
import { EdClient } from "../ed/mailbox.js";
import { EzdClient } from "../ezd/integrator.js";
import { type Context, print, required } from "./context.js";
import { performNow } from "./perform.js";

// `e-urzad approved <id>`: the one way a held office act is carried out, by the fresh turn the daemon starts after the
// owner approved it. The guard re-checks the item and the bytes; this re-checks that the card still points at the office
// the owner saw on the card (same instance, same environment, same mailbox).

const run = async (context: Context, operation: Operation, approvalId: string): Promise<void> => {
    if (operation.key.startsWith("ezdrp.")) {
        const card = pickCard(context.env, "ezd-rp", operation.card);
        const settings = ezdFromEnv(context.env, card);
        if (ezdTarget(settings) !== operation.target) {
            throw new Error(`the card now points at ${ezdTarget(settings)}, not ${operation.target} as approved; nothing was done`);
        }
        const records = new OfficeRecords(context.root, card, "ezd-rp");
        print(context, { approvalId, key: operation.key, result: await performNow(operation, { ezd: new EzdClient(settings) }, records, approvalId) });
        return;
    }
    const card = pickCard(context.env, "e-doreczenia", operation.card);
    const settings = edFromEnv(context.env, card);
    if (edTarget(settings) !== operation.target) {
        throw new Error(`the card now points at ${edTarget(settings)}, not ${operation.target} as approved; nothing was done`);
    }
    const records = new OfficeRecords(context.root, card, "e-doreczenia");
    print(context, { approvalId, key: operation.key, result: await performNow(operation, { ed: new EdClient(settings) }, records, approvalId) });
};

export const runApproved = async (context: Context, argv: readonly string[]): Promise<void> => {
    const approvalId = required(argv[0], "the approval id (e-urzad-…)");
    await run(context, await new ActionGuard(context.root).approved(approvalId), approvalId);
};
