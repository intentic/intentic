import type { LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import type { Asks } from "./asks.js";
import { type ControlEvent, type ControlMessage, parseControlLine } from "./control.js";
import { type Grant, grantFor, type Grants } from "./grants.js";
import type { LocalFilesServer } from "./server.js";

// What each line the app writes does once the server is up: a grant served or refused, a revoke, an answer to an ask
// this process made, an early office download. Every line that says something back says it through `say`.

export interface Channel {
    readonly grants: Grants;
    readonly server: Pick<LocalFilesServer, `forget`>;
    readonly office: Pick<LocalOffice, `prefetch`>;
    readonly asks: Pick<Asks, `answer`>;
    readonly say: (event: ControlEvent) => void;
    readonly log: (line: string) => void;
}

// The longest a timer waits in one go; a later end is waited for in steps.
const MAX_TIMER_MS = 2_147_483_647;

// A grant that ends by itself ends at its time even when no request comes to notice (grants.ts `expire`, which leaves a
// grant that replaced it under the same token alone).
const expireLater = (channel: Channel, grant: Grant): void => {
    const { expiresAt } = grant;
    if (expiresAt === undefined) {
        return;
    }
    setTimeout(
        () => {
            if (Date.now() < expiresAt) {
                expireLater(channel, grant);
            } else {
                channel.grants.expire(grant);
            }
        },
        Math.min(MAX_TIMER_MS, Math.max(0, expiresAt - Date.now())),
    ).unref();
};

const act = (channel: Channel, message: ControlMessage): void => {
    switch (message.op) {
        case `revoke`: {
            const revoked = channel.grants.revoke(message.token);
            if (revoked !== undefined) {
                void channel.server.forget(revoked);
            }
            channel.say({ event: `revoked`, token: message.token });
            return;
        }
        case `answer`:
            if (!channel.asks.answer(message)) {
                channel.log(`an answer for ${message.id} came after its ask had ended`);
            }
            return;
        case `prefetch-office`:
            void channel.office.prefetch().then((outcome) => channel.say({ event: `office`, ...outcome }));
            return;
        default:
            void grantFor(message).then((grant) => {
                if (`error` in grant) {
                    channel.say({ event: `refused`, token: message.token, error: grant.error });
                    return;
                }
                // A window the app re-points lets go of what its last grant held: its handlers, its office editor.
                const replaced = channel.grants.add(grant);
                if (replaced !== undefined) {
                    void channel.server.forget(replaced);
                }
                expireLater(channel, grant);
                // A folder grant has no file, which the line then leaves out.
                channel.say({ event: `granted`, token: grant.token, root: grant.root, name: grant.name, file: grant.file });
            });
    }
};

// Acts on one line of the app's; one that is not a message is logged and changes nothing. A grant that ends at its
// expiry, however that is noticed, is let go as a revoked one is, and the app told so.
export const controlChannel = (channel: Channel): ((line: string) => void) => {
    channel.grants.onExpired((grant) => {
        void channel.server.forget(grant);
        channel.say({ event: `revoked`, token: grant.token });
    });
    return (line) => {
        if (line.trim() === ``) {
            return;
        }
        const parsed = parseControlLine(line);
        if (`invalid` in parsed) {
            channel.log(`ignored a control line: ${parsed.invalid}`);
            return;
        }
        act(channel, parsed);
    };
};
