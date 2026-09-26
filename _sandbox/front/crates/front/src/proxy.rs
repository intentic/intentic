//! Every listener and every tunnel stream hand their requests here. Each resolves once to a destination (Node's Unix
//! socket, a preview's upstream, or a page Node rendered when asked) and is relayed as it stands; an upgrade becomes a
//! byte splice once the far side answers 101, whichever carrier brought it.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use std::convert::Infallible;

use front_wire::{
    Answer, FrontHeader, ListenConfig, Page, PreviewRoute, Question, Scheme, TerminalPlan, Upstream,
};
use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::request::Parts;
use http::{Method, Request, Response, StatusCode, Uri, Version};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use relay::body::{self, Body};
use relay::{for_next_hop, host_of, is_upgrade, strip_hop_by_hop};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::watch;
use tower_service::Service;

use crate::connect::{self, Io, NodeConnector, Pool, UpstreamConnector};
use crate::link::Link;
use crate::route::{self, Listener, Target};
use crate::term::{self, Terminals};

// The one disposition Node serves itself, named on the request it is handed back.
const OUTBOX: &str = "outbox";

// A restarting Node is waited for this long before a request is answered 503; its sockets stay open meanwhile.
const NODE_PATIENCE: Duration = Duration::from_secs(30);

// A resolved preview upstream is served as is this long; a panel that stops is noticed within it.
const PREVIEW_ROUTE_FRESH: Duration = Duration::from_secs(1);

// Past fresh and within this, the route is still served while Node is asked again in the background, so a daemon stalled
// in a collection or a sync call never holds a preview's request; past it, the request waits for Node's answer.
const PREVIEW_ROUTE_STALE: Duration = Duration::from_secs(60);

// Past this many hosts the cache sheds what has gone stale; only hosts Node resolved to an upstream are ever held.
const PREVIEW_ROUTE_ROOM: usize = 256;

const TERMINAL_UPGRADES: &str = "a terminal opens as a WebSocket";

pub struct Front {
    link: &'static Link,
    node: Pool<NodeConnector>,
    node_connector: NodeConnector,
    upstream: Pool<UpstreamConnector>,
    upstream_connector: UpstreamConnector,
    config: watch::Receiver<Option<Arc<ListenConfig>>>,
    previews: Mutex<HashMap<String, (Instant, Upstream)>>,
    refreshing: Mutex<HashSet<String>>,
    terminals: Arc<Terminals>,
}

enum Destination {
    /// Node's socket; `outbox` hands a preview request back marked as the outbox Node decided it is.
    Node {
        outbox: bool,
    },
    Upstream {
        upstream: Upstream,
        host: String,
        proto: &'static str,
        ancestors: Vec<String>,
    },
    /// Node's own answer, rendered when the front asked where the request goes.
    Page(Page),
    Unavailable,
}

impl Front {
    pub fn new(
        link: &'static Link,
        node_socket: std::path::PathBuf,
        config: watch::Receiver<Option<Arc<ListenConfig>>>,
        terminals: Arc<Terminals>,
    ) -> Self {
        let node_connector = NodeConnector::new(node_socket);
        let upstream_connector = UpstreamConnector::new();
        Self {
            link,
            node: connect::pool(node_connector.clone()),
            node_connector,
            upstream: connect::pool(upstream_connector.clone()),
            upstream_connector,
            config,
            previews: Mutex::new(HashMap::new()),
            refreshing: Mutex::new(HashSet::new()),
            terminals,
        }
    }

    pub async fn handle(
        self: &Arc<Self>,
        listener: Listener,
        mut request: Request<Incoming>,
    ) -> Response<Body> {
        strip_front_headers(request.headers_mut());
        let host = host_of(&request);
        let destination = self
            .destination(listener, &host, request.uri().path())
            .await;
        match destination {
            Destination::Unavailable => return unavailable(),
            Destination::Page(page) => return answer_page(page),
            _ => {}
        }
        if is_front_route(&destination, request.method(), request.uri().path()) {
            return self.terminal(request).await;
        }
        let upgrade = is_upgrade(request.headers(), request.version());
        let (mut parts, incoming) = request.into_parts();
        outbound(&destination, &mut parts, upgrade);
        let outbound = Request::from_parts(parts, body::incoming(incoming));
        if upgrade {
            return match self.dial(&destination, outbound.uri().clone()).await {
                Ok(io) => relay::exchange(io, outbound)
                    .await
                    .unwrap_or_else(|error| bad_gateway(&error.to_string())),
                Err(error) => bad_gateway(&error.to_string()),
            };
        }
        let sent = match &destination {
            Destination::Node { .. } => self.node.request(outbound).await,
            _ => self.upstream.request(outbound).await,
        };
        match (sent, destination) {
            (
                Ok(answer),
                Destination::Upstream {
                    upstream,
                    ancestors,
                    ..
                },
            ) => from_far_side(answer, upstream.frameable.then_some(&ancestors)),
            (Ok(answer), _) => from_far_side(answer, None),
            (Err(error), Destination::Upstream { upstream, host, .. }) => {
                tracing::debug!(error = %causes(&error), port = upstream.port, "a preview upstream did not answer");
                self.previews
                    .lock()
                    .expect("preview cache poisoned")
                    .remove(&host);
                self.unreachable(&host, upstream.port).await
            }
            (Err(error), _) => {
                tracing::warn!(error = %causes(&error), "the daemon did not answer a forwarded request");
                bad_gateway("the daemon did not answer")
            }
        }
    }

    /// Serves one stream a tunnel carrier brought (a QUIC stream, or a `/tunnel/v2` yamux one) as the HTTP/1.1
    /// connection it is: every request on it routed like any listener's, and an upgrade itself.
    pub async fn serve_stream<S>(self: &Arc<Self>, stream: S)
    where
        S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    {
        let front = self.clone();
        let service = service_fn(move |request| {
            let front = front.clone();
            async move { Ok::<_, Infallible>(front.handle(Listener::Tunnel, request).await) }
        });
        let _ = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades()
            .await;
    }

    async fn terminal(self: &Arc<Self>, mut request: Request<Incoming>) -> Response<Body> {
        let handshake = match request.version() {
            Version::HTTP_11 => term::Handshake::of(request.headers()),
            _ => None,
        };
        let Some(handshake) = handshake else {
            return plain(StatusCode::UPGRADE_REQUIRED, TERMINAL_UPGRADES);
        };
        let query = request.uri().query().unwrap_or_default().to_owned();
        let (plan, member) = match self.terminal_plan(&query).await {
            Ok(planned) => planned,
            Err(refusal) => return *refusal,
        };
        let upgrade = hyper::upgrade::on(&mut request);
        let terminals = self.terminals.clone();
        let switching = handshake.switching();
        tokio::spawn(async move {
            if let Ok(upgraded) = upgrade.await {
                terminals
                    .serve(TokioIo::new(upgraded), plan, member, &query)
                    .await;
            }
        });
        switching
    }

    // Asked before the socket opens, so a daemon that cannot answer fails the upgrade and the browser retries.
    async fn terminal_plan(
        &self,
        query: &str,
    ) -> Result<(TerminalPlan, Option<String>), Box<Response<Body>>> {
        let asked = self
            .link
            .ask(Question::Terminal {
                query: query.to_owned(),
            })
            .await;
        match asked {
            Ok(Answer::Terminal { plan, member }) => Ok((plan, member)),
            Ok(other) => {
                tracing::error!(
                    ?other,
                    "the daemon answered a terminal's question with another"
                );
                Err(Box::new(bad_gateway(
                    "the daemon could not plan the terminal",
                )))
            }
            Err(error) => {
                tracing::warn!(%error, "the daemon did not plan a terminal");
                Err(Box::new(unavailable()))
            }
        }
    }

    async fn destination(
        self: &Arc<Self>,
        listener: Listener,
        host: &str,
        path: &str,
    ) -> Destination {
        let config = self.config.borrow().clone();
        let sandbox_id = config
            .as_deref()
            .and_then(|config| config.sandbox_id.as_deref());
        match route::target(listener, host, sandbox_id) {
            Target::Node => self.node_destination(false).await,
            Target::Preview => {
                let Some(config) = config else {
                    return Destination::Unavailable;
                };
                // The probe reports the preview's state whatever it resolves to, so a cached upstream never answers it.
                let routed = if path == config.preview_probe_path {
                    self.resolve(host, true).await
                } else {
                    self.preview_route(host).await
                };
                match routed {
                    Ok(PreviewRoute::Upstream { upstream }) => Destination::Upstream {
                        upstream,
                        host: host.to_owned(),
                        proto: if listener == Listener::Tunnel {
                            "https"
                        } else {
                            "http"
                        },
                        ancestors: config.frame_ancestors.clone(),
                    },
                    Ok(PreviewRoute::Page { page }) => Destination::Page(page),
                    Ok(PreviewRoute::Outbox) => self.node_destination(true).await,
                    Err(error) => {
                        tracing::warn!(%error, host, "could not resolve a preview host");
                        Destination::Unavailable
                    }
                }
            }
        }
    }

    async fn node_destination(&self, outbox: bool) -> Destination {
        if self.link.ready(NODE_PATIENCE).await {
            Destination::Node { outbox }
        } else {
            Destination::Unavailable
        }
    }

    async fn preview_route(self: &Arc<Self>, host: &str) -> anyhow::Result<PreviewRoute> {
        let cached = self
            .previews
            .lock()
            .expect("preview cache poisoned")
            .get(host)
            .cloned();
        if let Some((at, upstream)) = cached {
            if at.elapsed() >= PREVIEW_ROUTE_FRESH && at.elapsed() < PREVIEW_ROUTE_STALE {
                self.refresh(host);
            }
            if at.elapsed() < PREVIEW_ROUTE_STALE {
                return Ok(PreviewRoute::Upstream { upstream });
            }
        }
        self.resolve(host, false).await
    }

    // One background question per host at a time; its answer replaces the stale route for everyone after it.
    fn refresh(self: &Arc<Self>, host: &str) {
        if !self
            .refreshing
            .lock()
            .expect("refresh set poisoned")
            .insert(host.to_owned())
        {
            return;
        }
        let front = self.clone();
        let host = host.to_owned();
        tokio::spawn(async move {
            if let Err(error) = front.resolve(&host, false).await {
                tracing::debug!(%error, host, "a background preview refresh failed; the stale route stands");
            }
            front
                .refreshing
                .lock()
                .expect("refresh set poisoned")
                .remove(&host);
        });
    }

    // Node decides once what becomes of the request; only an upstream is remembered, since a page is of its moment.
    async fn resolve(&self, host: &str, probe: bool) -> anyhow::Result<PreviewRoute> {
        if !self.link.ready(NODE_PATIENCE).await {
            anyhow::bail!("the daemon is not up to resolve {host}");
        }
        let answer = self
            .link
            .ask(Question::Preview {
                host: host.to_owned(),
                probe,
            })
            .await?;
        let Answer::Preview { route } = answer else {
            anyhow::bail!("the daemon answered {host}'s route with {answer:?}");
        };
        let mut previews = self.previews.lock().expect("preview cache poisoned");
        match &route {
            PreviewRoute::Upstream { upstream } if !probe => {
                if previews.len() >= PREVIEW_ROUTE_ROOM {
                    previews.retain(|_, (at, _)| at.elapsed() < PREVIEW_ROUTE_STALE);
                }
                previews.insert(host.to_owned(), (Instant::now(), upstream.clone()));
            }
            PreviewRoute::Upstream { .. } => {}
            PreviewRoute::Page { .. } | PreviewRoute::Outbox => {
                previews.remove(host);
            }
        }
        Ok(route)
    }

    // An upgrade dials a connection of its own, since an upgraded one never returns to a pool.
    async fn dial(&self, destination: &Destination, uri: Uri) -> std::io::Result<Io> {
        match destination {
            Destination::Node { .. } => self.node_connector.clone().call(uri).await,
            _ => self.upstream_connector.clone().call(uri).await,
        }
    }

    // The request was consumed by the failed attempt, so Node is asked for the page with a request of its own.
    async fn unreachable(&self, host: &str, port: u16) -> Response<Body> {
        let request = Request::builder()
            .uri("http://node/")
            .header(header::HOST, host)
            .header(FrontHeader::PreviewUnreachable.name(), port)
            .body(body::empty())
            .expect("a static request always builds");
        match self.node.request(request).await {
            Ok(answer) => from_far_side(answer, None),
            Err(_) => bad_gateway(&format!("nothing is answering on port {port}")),
        }
    }
}

// A route the front answers itself is the daemon's own: a preview's app may have a path of the same name.
fn is_front_route(destination: &Destination, method: &Method, path: &str) -> bool {
    matches!(destination, Destination::Node { outbox: false }) && term::serves(method, path)
}

fn strip_front_headers(headers: &mut HeaderMap) {
    for front in FrontHeader::ALL {
        headers.remove(front.name());
    }
}

// Rewrites a request for its destination: an h1 request to that address, Host present, hop-by-hop headers gone.
fn outbound(destination: &Destination, parts: &mut Parts, upgrade: bool) {
    if !parts.headers.contains_key(header::HOST)
        && let Some(authority) = parts
            .uri
            .authority()
            .and_then(|authority| HeaderValue::from_str(authority.as_str()).ok())
    {
        parts.headers.insert(header::HOST, authority);
    }
    for_next_hop(&mut parts.headers, upgrade);
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .to_owned();
    let base = match destination {
        Destination::Node { outbox } => {
            if *outbox {
                parts.headers.insert(
                    FrontHeader::Preview.name(),
                    HeaderValue::from_static(OUTBOX),
                );
            }
            "http://node".to_owned()
        }
        Destination::Upstream {
            upstream,
            host,
            proto,
            ..
        } => {
            let scheme = scheme_name(upstream.scheme);
            if let Ok(forwarded_host) = HeaderValue::from_str(host) {
                parts.headers.insert("x-forwarded-host", forwarded_host);
            }
            if !parts.headers.contains_key("x-forwarded-proto") {
                parts
                    .headers
                    .insert("x-forwarded-proto", HeaderValue::from_static(proto));
            }
            if upstream.localhost {
                let localhost = format!("localhost:{}", upstream.port);
                if parts.headers.contains_key(header::ORIGIN)
                    && let Ok(origin) = HeaderValue::from_str(&format!("{scheme}://{localhost}"))
                {
                    parts.headers.insert(header::ORIGIN, origin);
                }
                if let Ok(host) = HeaderValue::from_str(&localhost) {
                    parts.headers.insert(header::HOST, host);
                }
            }
            format!("{scheme}://{}:{}", uri_host(&upstream.host), upstream.port)
        }
        Destination::Page(_) | Destination::Unavailable => {
            unreachable!(
                "a page and an unavailable destination are answered before a request is rewritten for them"
            )
        }
    };
    parts.uri = format!("{base}{path}")
        .parse()
        .unwrap_or_else(|_| Uri::from_static("http://node/"));
    parts.version = Version::HTTP_11;
}

// An IPv6 literal (a dev server bound to `::1` alone) is bracketed in a URI, or the port reads as part of it.
fn uri_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    }
}

fn scheme_name(scheme: Scheme) -> &'static str {
    match scheme {
        Scheme::Http => "http",
        Scheme::Https => "https",
    }
}

fn from_far_side(
    answer: Response<Incoming>,
    frame_ancestors: Option<&Vec<String>>,
) -> Response<Body> {
    let (mut parts, incoming) = answer.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    if let Some(ancestors) = frame_ancestors {
        frameable(&mut parts.headers, ancestors);
    }
    Response::from_parts(parts, body::incoming(incoming))
}

// A preview may be framed by the editor's origins and by itself (an app framing its own pages is checked against the
// preview's origin too), whatever the upstream app's own policy says.
fn frameable(headers: &mut HeaderMap, ancestors: &[String]) {
    headers.remove("x-frame-options");
    let sources = std::iter::once("'self'")
        .chain(ancestors.iter().map(String::as_str))
        .collect::<Vec<_>>()
        .join(" ");
    let policies: Vec<String> = headers
        .get_all(header::CONTENT_SECURITY_POLICY)
        .iter()
        .filter_map(|value| value.to_str().ok().map(str::to_owned))
        .collect();
    headers.remove(header::CONTENT_SECURITY_POLICY);
    if policies.is_empty() {
        if let Ok(value) = HeaderValue::from_str(&format!("frame-ancestors {sources}")) {
            headers.insert(header::CONTENT_SECURITY_POLICY, value);
        }
        return;
    }
    for policy in policies {
        if let Ok(value) = HeaderValue::from_str(&with_frame_ancestors(&policy, &sources)) {
            headers.append(header::CONTENT_SECURITY_POLICY, value);
        }
    }
}

fn with_frame_ancestors(policy: &str, sources: &str) -> String {
    policy
        .split(';')
        .map(str::trim)
        .filter(|directive| {
            let name = directive.split_whitespace().next().unwrap_or("");
            !directive.is_empty() && !name.eq_ignore_ascii_case("frame-ancestors")
        })
        .map(str::to_owned)
        .chain(std::iter::once(format!("frame-ancestors {sources}")))
        .collect::<Vec<_>>()
        .join("; ")
}

// Node's page as it rendered it: its status, its headers and its body, nothing added.
fn answer_page(page: Page) -> Response<Body> {
    let mut response = Response::new(body::full(page.body));
    *response.status_mut() = StatusCode::from_u16(page.status).unwrap_or(StatusCode::BAD_GATEWAY);
    for (name, value) in page.headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(name), HeaderValue::try_from(value)) {
            response.headers_mut().append(name, value);
        }
    }
    response
}

// hyper-util's error names only the stage it failed in ("client error (SendRequest)"); the cause is its sources.
fn causes(error: &(dyn std::error::Error + 'static)) -> String {
    let mut text = error.to_string();
    let mut source = error.source();
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

fn plain(status: StatusCode, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body::full(message.to_owned()))
        .expect("a static response always builds")
}

fn unavailable() -> Response<Body> {
    let mut response = plain(
        StatusCode::SERVICE_UNAVAILABLE,
        "the sandbox daemon is restarting",
    );
    response
        .headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
    response
}

fn bad_gateway(message: &str) -> Response<Body> {
    plain(StatusCode::BAD_GATEWAY, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_forwarding_failure_is_logged_with_what_caused_it() {
        #[derive(Debug)]
        struct Stage(std::io::Error);
        impl std::fmt::Display for Stage {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("client error (SendRequest)")
            }
        }
        impl std::error::Error for Stage {
            fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
                Some(&self.0)
            }
        }
        let reset = std::io::Error::new(
            std::io::ErrorKind::ConnectionReset,
            "connection reset by peer",
        );
        assert_eq!(
            causes(&Stage(reset)),
            "client error (SendRequest): connection reset by peer"
        );
    }

    #[test]
    fn an_ipv6_upstream_is_bracketed_in_its_uri() {
        assert_eq!(uri_host("::1"), "[::1]");
        assert_eq!(uri_host("[::1]"), "[::1]");
        assert_eq!(uri_host("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn frame_ancestors_replaces_the_apps_own_and_keeps_the_rest() {
        assert_eq!(
            with_frame_ancestors(
                "default-src 'self'; frame-ancestors 'none';img-src *",
                "'self' https://app.example"
            ),
            "default-src 'self'; img-src *; frame-ancestors 'self' https://app.example"
        );
        assert_eq!(
            with_frame_ancestors("frame-ancestors", "'self'"),
            "frame-ancestors 'self'"
        );
    }

    #[test]
    fn a_frameable_answer_drops_x_frame_options_and_sets_its_ancestors() {
        let mut headers = HeaderMap::new();
        headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
        frameable(&mut headers, &["https://app.example".to_owned()]);
        assert!(!headers.contains_key("x-frame-options"));
        assert_eq!(
            headers[header::CONTENT_SECURITY_POLICY],
            "frame-ancestors 'self' https://app.example"
        );
    }

    #[test]
    fn a_page_is_written_as_node_rendered_it() {
        let page = Page {
            status: 404,
            headers: [
                (
                    "content-type".to_owned(),
                    "text/html; charset=utf-8".to_owned(),
                ),
                ("bad name".to_owned(), "dropped".to_owned()),
            ]
            .into(),
            body: "<p>No preview here</p>".into(),
        };
        let response = answer_page(page);
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "text/html; charset=utf-8"
        );
        assert_eq!(response.headers().len(), 1);
    }
}
