import { useSandboxSession } from "../../client/session/sandboxSession";

// Whether a card's answerer is somebody other than the reader, case-insensitively, since a verified address and a
// presented one may differ in nothing else. A card names only those (ChatCardPerson).
export const useSomeoneElse = (): ((who: string | undefined) => who is string) => {
    const { presentedEmail } = useSandboxSession();
    return (who: string | undefined): who is string => who !== undefined && who !== `` && who.toLowerCase() !== presentedEmail.value?.toLowerCase();
};
