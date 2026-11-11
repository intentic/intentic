import { procedure } from "../protocol/route-meta.js";
import { HubSavedSchema, HubSaveSchema, HubStateSchema, HubTakenSchema, HubTakeSchema } from "../schemas/connection-hub.js";

// The connections hub (schemas/connection-hub.ts): the keyring on one of the owner's computers holding the connections
// they want in more than one sandbox. Saving puts a credential in motion and taking asks the computer for one, so these
// are the operating tier's and no token's; the computer still asks its person before either happens.
const hubRoute = procedure.meta({ floor: "maintainer", control: "never", panel: false });

export const hubContract = {
    state: hubRoute
        .route({
            method: "GET",
            path: "/hub",
            summary: "Connections on your computer, and which held here can go there",
            description:
                "The owner's computers whose keyring can hold connections; every card and model account held here, whether it can go to the hub and why not, which were saved there from here and which were made here from it; and any entry shared here that could not be made into a connection. No credential is in the answer.",
        })
        .output(HubStateSchema),
    save: hubRoute
        .route({
            method: "POST",
            path: "/hub/save",
            summary: "Save a connection to your computer",
            description:
                "Sends one card or static model account to the named computer's keyring, sealed to it, to keep as a hub entry shared back here. The person at the computer says yes first; a locked keyring holds it until the next unlock. Saving the same connection again replaces that entry, so every sandbox using it gets the new value.",
        })
        .input(HubSaveSchema)
        .output(HubSavedSchema),
    take: hubRoute
        .route({
            method: "POST",
            path: "/hub/take",
            summary: "Use a connection saved on your computer",
            description:
                "Asks the owner's computers for a saved connection of this kind. The keyring offers the person what matches and shares the one they pick here; it is then made into a card or account here and follows that entry from then on.",
        })
        .input(HubTakeSchema)
        .output(HubTakenSchema),
};
