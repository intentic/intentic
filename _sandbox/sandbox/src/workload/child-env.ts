// The daemon uses a large libuv pool for filesystem/DNS work. Development tools inherit a smaller pool;
// callers can still choose their own size explicitly in the child's environment or command. A supplied environment
// replaces inheritance, just as it does for spawn: restricted environments must not regain daemon variables.
export const childEnv = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...(env ?? process.env),
    UV_THREADPOOL_SIZE: env?.["UV_THREADPOOL_SIZE"] ?? "4",
});
