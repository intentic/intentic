// The daemon's JSON answer: a body and a status, typed the way every client of the contract parses one.
export const json = <Body>(body: Body, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });
