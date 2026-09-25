// A call a dedicated worker answers, or the page when it cannot, reachable without the component barrel: the worker
// half runs inside a worker, where the kit's Vue components and `document` do not exist. In-repo extensions bundle it
// from source; a git-installed bundle's worker has no host bridge to read, so it must bundle this module rather than
// mark it external.
export {
    createWorkerCall,
    serveWorkerCall,
    type ServeOptions,
    type WorkerCall,
    type WorkerCallOptions,
    WorkerCallError,
    type WorkerCallRequest,
    type WorkerCallResponse,
    type WorkerFactory,
    type WorkerPort,
} from "@intentic/ui/worker-call";
