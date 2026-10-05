import type { PhoneConfig } from "@intentic/sandbox-contract";
import { PHONE_TOOLS_NOTE } from "../../phones/phone-skills.js";
import { peerHandler } from "./peer.handler.js";

/* A PHONE OF THE USER'S OWN, reached through the app they installed on it: the peer handler (peers/) over the phones door. */
export const phoneHandler = peerHandler<PhoneConfig>({
    kind: "phone",
    noun: "phone",
    where: "on that phone",
    note: PHONE_TOOLS_NOTE,
    pairHint: "click Connect and scan the code with that phone's camera",
    awayHint: "asleep; the agent's first call wakes it",
    added: (id) =>
        `Added "${id}". Install Intentic Device on that phone and scan the code its entry is offering; the agent can work on it from the next turn.`,
    store: (ctx) => ctx.phones,
    hub: (ctx) => ctx.phoneHub,
    // Woken through the push relay once the editor registered its token; without that it answers only while its app is
    // open or set to stay connected, and reads as away.
    wakeable: async (ctx, id) => (await ctx.phoneWake.state(id, ctx.phoneHub.state(id).facts)) === "ready",
    kept: {
        rekey: (ctx, from, to) => ctx.phoneWake.rekey(from, to),
        forget: (ctx, id) => ctx.phoneWake.forget(id),
    },
    echo: (phone) => ({
        platform: phone.platform,
        screen: phone.screen,
        control: phone.control,
        files: phone.files,
        write: phone.write,
        notifications: phone.notifications,
        apps: phone.apps,
        destructive: phone.destructive,
        confirm: phone.confirm,
    }),
});
