/* THE CLOUDFLARE-ONLY THINGS `worker.ts` USES, declared rather than depended on (as _site/site/worker-runtime.d.ts
does): this directory is no workspace package, so it has no @cloudflare/workers-types to read. */

interface SqlStorageCursor<Row> extends Iterable<Row> {
    toArray(): Row[];
    one(): Row;
}

interface SqlStorage {
    exec<Row = Record<string, string | number | null>>(query: string, ...bindings: (string | number | null)[]): SqlStorageCursor<Row>;
}

interface DurableObjectState {
    readonly storage: { readonly sql: SqlStorage };
}

interface DurableObjectId {
    toString(): string;
}

interface DurableObjectNamespace<Stub> {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): Stub;
}

interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
}

interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
}

declare module "cloudflare:workers" {
    export abstract class DurableObject<Env = unknown> {
        protected readonly ctx: DurableObjectState;
        protected readonly env: Env;
        constructor(ctx: DurableObjectState, env: Env);
    }
}
