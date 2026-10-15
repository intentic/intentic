import type { ExtensionServerApi, ExtensionServerContext } from "@intentic/extension-api";
import { z } from "zod";
import { edFromConfig, ezdFromConfig, type Service } from "../core/cards.js";
import { OfficeRecords } from "../core/records.js";
import { EdClient } from "../ed/mailbox.js";
import { syncInbox } from "../ed/deliveries.js";
import { EzdClient } from "../ezd/integrator.js";
import { syncCasesAndTasks } from "../ezd/sync.js";
import { causeText, ensureCryptoEngines } from "../signatures/engine.js";
import { ezdTools } from "./tools.js";

// The backend: the EZD RP card's agent tools (tools.ts), and the rail view's three requests per connected card,
// served from this extension's own namespace. The view reads what is saved; Refresh and Test read the office live, with
// the card's settings read through the daemon every time (never a copy), and only ever read: no office write is
// reachable from the view.

const ServiceSchema = z.enum(["ezd-rp", "e-doreczenia"]);

const json = <T>(body: T, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

class NotOffice extends Error {}

const ROUTE = /^\/accounts\/([^/]+)\/(overview|sync|test)$/;

export const activateServer = (api: ExtensionServerApi, _context: ExtensionServerContext): void => {
    ensureCryptoEngines();
    api.tools.serve((card) => (card === undefined ? [] : ezdTools(card, api.workspaceRoot)));

    // The typed contract call: the daemon answers only for a card of a kind this extension contributes.
    const connection = async (id: string): Promise<{ readonly service: Service; readonly config: Readonly<Record<string, string>> }> => {
        const read = await api.daemon.rpc.capabilities.connection({ id });
        const service = ServiceSchema.safeParse(read.config["provider"]);
        if (read.kind !== "cli" || !service.success) {
            throw new NotOffice(`"${id}" is not a connected EZD RP or e-Doręczenia card`);
        }
        return { service: service.data, config: read.config };
    };

    const sync = async (id: string): Promise<Response> => {
        const { service, config } = await connection(id);
        const records = new OfficeRecords(api.workspaceRoot, id, service);
        if (service === "ezd-rp") {
            await syncCasesAndTasks(new EzdClient(ezdFromConfig(id, config)), records);
        } else {
            await syncInbox(new EdClient(edFromConfig(id, config)), records);
        }
        return json({ snapshot: await records.snapshot() });
    };

    const test = async (id: string): Promise<Response> => {
        const { service, config } = await connection(id);
        const detail = service === "ezd-rp" ? await new EzdClient(ezdFromConfig(id, config)).test() : await new EdClient(edFromConfig(id, config)).test();
        return json({ ok: true, service, detail });
    };

    api.routes.mount(async (request) => {
        const match = ROUTE.exec(new URL(request.url).pathname);
        if (match === null || match[1] === undefined) {
            return undefined;
        }
        const id = decodeURIComponent(match[1]);
        try {
            if (match[2] === "overview" && request.method === "GET") {
                const service = ServiceSchema.parse(new URL(request.url).searchParams.get("service"));
                return json({ snapshot: await new OfficeRecords(api.workspaceRoot, id, service).snapshot() });
            }
            if (request.method !== "POST") {
                return undefined;
            }
            return match[2] === "sync" ? await sync(id) : await test(id);
        } catch (cause) {
            return json({ error: causeText(cause) }, cause instanceof NotOffice ? 404 : 502);
        }
    });
};
