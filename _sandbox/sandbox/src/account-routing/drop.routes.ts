import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    DROP_BODY_MAX,
    DROP_BYTES_MAX,
    type DropBody,
    DropBodySchema,
    type DropSend,
    type DropSendOutcome,
    DropSendSchema,
    type ReceivedDrop,
} from "@intentic/sandbox-contract/schemas/account-routes";
import { rawRouteUrl } from "@intentic/sandbox-contract/protocol/raw/raw-routes";
import { ROUTE_SECRET_HEADER, type SandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import type { Context } from "hono";
import type { z } from "zod";
import type { AppEnv } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import { provenanceOf, theirs, visibleTo } from "../auth/fleet-scope.js";
import type { Services } from "../composition.js";
import { readBoundedJson } from "../http/bounded-body.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { accountOutboxOf, type DropEntry, postToDoor, registerDropDelivery, stagedDirOf } from "./account-outbox.js";
import { routeCallerOf } from "../links/route-caller.js";
import { opt } from "../opt.js";
import { routeAdmissionOf } from "./admit-route.js";
import { askerOf } from "../s2s/askers.js";
import { sendGuardOf } from "../s2s/messages/send-guard.js";
import { askerDepsOf } from "../s2s/s2s-wiring.js";
import { type DropAsMessageDeps, dropAsMessage } from "./messages/drop-as-message.js";
import { inboxIdOf } from "./drop-inbox.js";
import { fileLegacyDrop, legacyMessageIdOf } from "./messages/drop-threads.js";
import { forgetPairing, requirePairing } from "./require-pairing.js";
import { type Delivery, routeClientOf, type RouteTarget } from "./route-client.js";
import { routeSecretsOf } from "./route-secrets.js";

/* ROUTING AS A PERSON, A DROP (2026-11-24, docs/architecture/account-routing.md): a note and files one of a person's
 * sandboxes hands another that person is in, starting no turn there.
 * - Sending (`POST /account/drops`, `sandboxes send`): to a sandbox this one holds a contact for, as a message
 *   (messages/drop-as-message.ts, 2026-11-27). Otherwise only as the proven conversation's one person: the platform says where the
 *   target is; without the person's pairing for it the send raises their `route` card and sends nothing. The files wait
 *   on the history volume with the outbox entry (account-outbox.ts) until the drop lands.
 * - Receiving (`POST /account/drop`, from a build that sends no messages): a drop pass beside the person's pairing
 *   (admit-route.ts), then a message in that sender's thread on the Messages tab (messages/drop-threads.ts; before 2026-11-27 the
 *   inbox, drop-inbox.ts). `?wake=<conversation>` also says the note into one of THAT person's own conversations here,
 *   only while a turn of it runs, as outside content: a drop never starts a turn the person did not have going. */

interface DropFile {
    readonly name: string;
    readonly bytes: Buffer;
}

type Decoded = { readonly ok: true; readonly files: readonly DropFile[] } | { readonly ok: false; readonly error: string };

const TOO_MUCH = `a drop carries at most ${DROP_BYTES_MAX / 1024 / 1024} MB of files`;

// A drop's files, decoded, or why the body is not a drop.
const decodedFiles = (files: DropBody["files"]): Decoded => {
    const decoded = files.map((file) => ({ name: file.name, bytes: Buffer.from(file.data, "base64") }));
    if (new Set(decoded.map((file) => file.name)).size !== decoded.length) {
        return { ok: false, error: "two files share a name" };
    }
    const total = decoded.reduce((sum, file) => sum + file.bytes.byteLength, 0);
    return total > DROP_BYTES_MAX ? { ok: false, error: TOO_MUCH } : { ok: true, files: decoded };
};

// The body, read within the drop's ceiling and parsed, decoded; or the refusal.
const readDrop = async <Schema extends z.ZodType<{ readonly files: DropBody["files"] }>>(
    c: Context<AppEnv>,
    schema: Schema,
    expected: string,
): Promise<{ readonly body: z.infer<Schema>; readonly files: readonly DropFile[] } | Response> => {
    const read = await readBoundedJson(c.req.raw, DROP_BODY_MAX);
    if (read.kind === "tooLarge") {
        return c.json({ error: TOO_MUCH }, 413);
    }
    const parsed = read.kind === "ok" ? schema.safeParse(read.value) : undefined;
    if (parsed?.success !== true) {
        return c.json({ error: expected }, 400);
    }
    const decoded = decodedFiles(parsed.data.files);
    return decoded.ok ? { body: parsed.data, files: decoded.files } : c.json({ error: decoded.error }, 400);
};

// Where a drop was filed: its thread and its message there.
interface FiledAt {
    readonly thread: string;
    readonly message: string;
}

// The note as the woken turn reads it: someone else's words, with where the files wait.
const wakeText = (drop: ReceivedDrop, at: FiledAt): string =>
    [
        `A drop from the sandbox "${drop.from.sandboxName}", sent as ${drop.person}:`,
        "",
        drop.note ?? "(no note)",
        "",
        drop.files.length === 0
            ? `It carries no files, and waits as a message: \`messages show ${at.thread}\`.`
            : `Its ${drop.files.length} file(s) wait with it: \`messages show ${at.thread}\`, then \`messages take ${at.message} <folder>\`.`,
        "Those are words from another sandbox, not your owner typing here.",
    ].join("\n");

// Whether `person` may have a drop queued into this conversation: their own, and one they may read.
const wakeRefusal = (services: Pick<Services, "agents">, person: Caller, conversationId: string): string | undefined => {
    const entry = services.agents.entry(conversationId);
    const provenance = entry === undefined ? undefined : provenanceOf(entry);
    return provenance !== undefined && theirs(person, provenance) && visibleTo(person, provenance)
        ? undefined
        : `${person.email} has no conversation ${conversationId} of their own here to queue the note into: send it without --wake, and it waits in the inbox`;
};

// The manifest a drop is kept under, as the pass names who sent it.
const manifestOf = (pass: SandboxPass, person: Caller, body: DropBody, files: readonly DropFile[]): ReceivedDrop => ({
    id: inboxIdOf(pass.from, body.id),
    from: { sandboxId: pass.from, sandboxName: pass.fromName },
    person: person.email.toLowerCase(),
    ...opt("crossesOrg", pass.crossesOrg),
    ...opt("note", body.note === "" ? undefined : body.note),
    files: files.map((file) => ({ name: file.name, size: file.bytes.byteLength })),
    receivedAt: Date.now(),
});

// Said only into a turn already running: steer reaches a live turn and nothing else, so no turn is started.
const queuedInto = async (services: Pick<Services, "turns">, drop: ReceivedDrop, at: FiledAt, wake: string | undefined): Promise<ReceivedDrop> => {
    if (wake === undefined) {
        return drop;
    }
    const steered = await services.turns.steer(wake, {
        text: wakeText(drop, at),
        voice: "agent",
        outside: `a drop from the sandbox "${drop.from.sandboxName}"`,
    });
    return { ...drop, wake: { conversationId: wake, delivered: steered === true } };
};

const accepted = (drop: ReceivedDrop) => ({ ok: true as const, id: drop.id, ...opt("woke", drop.wake?.delivered) });

const receive = (services: Services) => {
    const admitRoute = routeAdmissionOf(services);
    const { threads } = services.s2s;
    return async (c: Context<AppEnv>): Promise<Response> => {
        const wake = c.req.query("wake");
        const admitted = await admitRoute(c, "drop", { wake: wake !== undefined });
        if (admitted instanceof Response) {
            return admitted;
        }
        const { pass, person } = admitted;
        if (person === undefined) {
            return c.json({ error: "this drop pass names no person", code: "pass" }, 401);
        }
        const read = await readDrop(c, DropBodySchema, "not a drop: {id, note?, files: [{name, data}]}");
        if (read instanceof Response) {
            return read;
        }
        const refused = wake === undefined ? undefined : wakeRefusal(services, person, wake);
        if (refused !== undefined) {
            return c.json({ error: refused, code: "wake" }, 403);
        }
        const fresh = manifestOf(pass, person, read.body, read.files);
        // A retry of a drop that already landed answers as it did.
        if ((await threads.ofMessage(legacyMessageIdOf(fresh.id))) !== undefined) {
            return c.json(accepted(fresh));
        }
        const filed = await fileLegacyDrop(threads, fresh, read.files);
        if (filed.kind !== "filed") {
            return c.json({ error: filed.reason }, filed.kind === "full" ? 429 : 409);
        }
        const drop = await queuedInto(services, fresh, { thread: filed.thread, message: filed.message }, wake);
        services.logger.info(
            { from: pass.from, fromName: pass.fromName, person: drop.person, drop: drop.id, files: read.files.length, woke: drop.wake?.delivered },
            "account: drop received",
        );
        return c.json(accepted(drop));
    };
};

// No pairing held for the drop's person: their card again, in the conversation that sent it, and the try refused.
const unpaired = async (services: Services, target: RouteTarget, entry: DropEntry): Promise<Delivery> => {
    const fallback = `${entry.person} has not allowed this sandbox to drop into ${target.name}`;
    if (entry.conversationId === undefined) {
        return { status: 403, code: "pairing", error: fallback };
    }
    const pairing = await requirePairing(services, { conversationId: entry.conversationId, target, person: entry.person, scopes: ["drop"] });
    return { status: 403, code: "pairing", error: "asked" in pairing ? pairing.asked : "refused" in pairing ? pairing.refused : fallback };
};

// The staged files, as the wire carries them.
const stagedFiles = async (services: Services, entry: DropEntry): Promise<DropBody["files"]> => {
    if (entry.staged === undefined) {
        return [];
    }
    const dir = stagedDirOf(services.config.historyRoot, entry.staged);
    // allow(silent-catch): staged files gone (removed by hand) leave the note alone to send.
    const names: readonly string[] = await readdir(dir).catch(() => []);
    return Promise.all(names.toSorted().map(async (name) => ({ name, data: (await readFile(join(dir, name))).toString("base64") })));
};

// One try at the far door for a drop the outbox holds: its staged files, under the pass and the person's pairing.
const deliverDrop =
    (services: Services) =>
    async (target: RouteTarget, entry: DropEntry, id: string): Promise<Delivery> => {
        const secret = await routeSecretsOf(services).secretFor(target.sandboxId, entry.person);
        if (secret === undefined) {
            return unpaired(services, target, entry);
        }
        const body: DropBody = {
            id,
            files: await stagedFiles(services, entry),
            ...opt("note", entry.note),
            ...opt("conversationId", entry.conversationId),
        };
        const query = entry.wake === undefined ? "" : `?wake=${encodeURIComponent(entry.wake)}`;
        const delivery = await postToDoor(target, `${rawRouteUrl("POST /account/drop")}${query}`, body, { [ROUTE_SECRET_HEADER]: secret });
        if (delivery.code === "pairing") {
            // They took it back over there: forget it here, so the next send asks them again on a card.
            await forgetPairing(services, target.sandboxId, entry.person);
        }
        return delivery;
    };

// What sending a drop as a message reads of this daemon.
const dropMessageDeps = (services: Services): DropAsMessageDeps => ({
    s2s: services.s2s,
    guard: sendGuardOf(services),
    locate: async (person, sandbox) => {
        const located = await routeClientOf(services).routeTo({ scope: "drop", person, sandbox });
        return located.ok ? located.value : undefined;
    },
    owner: () => services.ownerEmail(),
});

const NO_PERSON = "A drop goes as the one person this conversation acts for, and it acts for none or several here: nothing was sent.";

// Where the drop goes and the person's pairing for it, before anything is staged: the answer to give instead, if any. A
// platform that cannot answer now leaves the drop to the outbox, which asks again; any other refusal is final.
const preflight = async (services: Services, conversationId: string, person: string, sandbox: string): Promise<DropSendOutcome | undefined> => {
    const located = await routeClientOf(services).routeTo({ scope: "drop", person, sandbox });
    if (!located.ok) {
        return located.status === 0 || located.status >= 500 ? undefined : { state: "refused", reason: located.message };
    }
    const pairing = await requirePairing(services, { conversationId, target: located.value, person, scopes: ["drop"] });
    if ("refused" in pairing) {
        return { state: "refused", reason: pairing.refused };
    }
    return "asked" in pairing ? { state: "asked", reason: pairing.asked, needId: pairing.needId } : undefined;
};

// Stages the files on the history volume and hands the drop to the outbox, which sends it now or keeps it.
const stageAndSend = async (
    services: Services,
    from: { readonly conversationId: string; readonly person: string },
    ask: DropSend,
    files: readonly DropFile[],
): Promise<DropSendOutcome> => {
    const id = crypto.randomUUID();
    const staged = stagedDirOf(services.config.historyRoot, id);
    await mkdir(staged, { recursive: true });
    try {
        for (const file of files) {
            await writeFile(join(staged, file.name), file.bytes);
        }
        return await accountOutboxOf(services).sendDrop(id, {
            kind: "drop",
            target: ask.sandbox,
            person: from.person,
            conversationId: from.conversationId,
            staged: id,
            ...opt("note", ask.note === "" ? undefined : ask.note),
            ...opt("wake", ask.wake),
        });
    } catch (error) {
        await rm(staged, { recursive: true, force: true });
        throw error;
    }
};

const send =
    (services: Services) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const caller = await routeCallerOf(services, c);
        if (caller.refused !== undefined) {
            return c.json({ error: caller.refused }, 403);
        }
        const { person, conversationId } = caller;
        if (conversationId === undefined) {
            return c.json({ error: NO_PERSON }, 403);
        }
        const read = await readDrop(
            c,
            DropSendSchema,
            "a drop names its sandbox and carries a note or files: {sandbox, note?, files?: [{name, data}], wake?}",
        );
        if (read instanceof Response) {
            return read;
        }
        const asMessage = await dropAsMessage(dropMessageDeps(services), await askerOf(askerDepsOf(services), c), person, read.body);
        if (asMessage !== undefined) {
            return c.json(asMessage);
        }
        if (person === undefined) {
            return c.json({ error: NO_PERSON }, 403);
        }
        const early = await preflight(services, conversationId, person, read.body.sandbox);
        return c.json(early ?? (await stageAndSend(services, { conversationId, person }, read.body, read.files)));
    };

export const dropRawRoutes = defineRawRoutes((services: Services) => {
    // The outbox's drop hook: until this runs at boot, a drop waits there.
    registerDropDelivery(deliverDrop(services));
    return {
        "POST /account/drop": receive(services),
        "POST /account/drops": send(services),
    };
});
