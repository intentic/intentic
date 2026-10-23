import { t } from "@intentic/ui/i18n";
import { landRequestWork, requestLandAgent } from "../../../../models/fleet/agentActions";
import { useOperation } from "../../../../workbench/operations/operations";

// The collaborator's land request and its receipt survive leaving the review that asked for it.
export const useLandRequest = (context: () => { id: string; box: string | undefined; title: string }, refresh: (box: string | undefined) => Promise<void>) => {
    const landAsk = useOperation(() => landRequestWork(context().id, context().box));
    const requestLand = async (): Promise<void> => {
        const { id, box, title: name } = context();
        await landAsk.run({
            what: t(`agents.agentDetail.requestingLand`, { name }),
            done: () => t(`agents.agentDetail.landRequestSent`, { name }),
            failed: t(`agents.agentCard.couldntSendLandRequest`),
            task: async () => {
                await requestLandAgent(id, box);
                await refresh(box);
            },
        });
    };
    return { landAsk, requestLand };
};
