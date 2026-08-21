# Point the agent at my errors and traces

As someone who wants an agent that can answer "what broke last night", I want to connect my error tracker and my metrics stack, so that debugging starts from what actually happened rather than from what I remember.

These cards are the self-hosted case done properly. My Sentry might be sentry.io or my own instance; my SigNoz is almost certainly mine. So the card takes the instance URL first, and the link to "create a token" follows that URL: it points at my instance once I have named it, and stays hidden until it has somewhere to point.

Connecting is only half the promise. The value shows up in a conversation, where I ask about an error and get the real issue back. Until that works, a connection is a configuration entry, not a capability.

## Acceptance criteria

- [ ] The Observability section lists the error-tracking and metrics cards with a line saying what can be queried
- [ ] The form takes the instance URL, and the credential link resolves against that URL rather than a fixed hosted address
- [ ] Before an instance URL is entered, the form does not offer a broken credential link
- [ ] Any organisation or project identifier the provider needs is asked for as its own field, not buried in the URL
- [ ] The credential field is masked and the page states that it is stored only inside the sandbox
- [ ] Submitting with a malformed URL is rejected with a message saying what is expected
- [ ] A connected instance appears under Connected with its state, and can be removed with a confirmation
- [ ] With a connection active, asking the agent about recent errors or traces returns real data from that instance
