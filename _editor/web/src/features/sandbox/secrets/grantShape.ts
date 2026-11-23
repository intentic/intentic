// WHAT A SIGN-IN'S OWN GRANT LOOKS LIKE, so a paste anywhere on the window or the clipboard on return is taken without a
// press when it is this attempt's, and left alone when it is not. A redirect dead-ends on a loopback address the page can
// never load: most people never read the picture of it (DeadEndPicture.vue), since their paste is recognised here.

// A landing address carrying this handshake's grant: the query param plus its issuing `state`, so an unrelated clipboard
// string is ignored. Checks both `code=` and `authCode=` (BigModel names it the second way). A blank `state` (a flow that
// issued none) takes any grant.
export const isOurRedirect = (text: string, state: string): boolean =>
    (text.includes(`code=`) || text.includes(`authCode=`)) && (state === `` || text.includes(state));

// A paste-back code carrying this attempt's own state after a `#`, as Anthropic's page shows it (`code#state`, where the
// state is the attempt the sandbox handed back as its handshake). Nothing else counts: Devin's token carries no state,
// and a bare code could be half of something, so those still wait for the press.
export const isOurCode = (text: string, handshake: string): boolean => {
    const [code = ``, state, ...rest] = text.split(`#`);
    return handshake !== `` && rest.length === 0 && state === handshake && /^\S+$/.test(code);
};
