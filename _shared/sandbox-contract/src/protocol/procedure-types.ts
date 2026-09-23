import type { AnySchema, ContractProcedure, ErrorMap, InferSchemaInput, InferSchemaOutput, Meta } from "@orpc/contract";
import type { sandboxContract } from "../index.js";

// Every procedure's wire types by group and name, from both ends: what a caller sends, and what a handler is given and
// may answer. The two ends differ wherever a schema coerces or defaults, so a stand-in daemon types itself by the
// handler's end and a caller by its own.

type Contract = typeof sandboxContract;

export type SandboxGroup = keyof Contract;
export type SandboxProcedure<G extends SandboxGroup> = keyof Contract[G] & string;

// What a caller hands the typed client, before the client spreads it over the path, the query and the body.
export type SandboxCallInput<G extends SandboxGroup, P extends SandboxProcedure<G>> =
    Contract[G][P] extends ContractProcedure<infer I extends AnySchema, AnySchema, ErrorMap, Meta> ? InferSchemaInput<I> : never;

// What a handler is given: the request's input as the input schema parsed it, a query's "true" already a boolean.
export type SandboxHandlerInput<G extends SandboxGroup, P extends SandboxProcedure<G>> =
    Contract[G][P] extends ContractProcedure<infer I extends AnySchema, AnySchema, ErrorMap, Meta> ? InferSchemaOutput<I> : never;

// What a handler may answer: anything the output schema parses, so a defaulted field may be left out. A streamed
// procedure's is an async iterator of frames in the same sense.
export type SandboxHandlerOutput<G extends SandboxGroup, P extends SandboxProcedure<G>> =
    Contract[G][P] extends ContractProcedure<AnySchema, infer O extends AnySchema, ErrorMap, Meta> ? InferSchemaInput<O> : never;
