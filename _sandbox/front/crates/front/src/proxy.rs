//! Every listener and the tunnel hand their requests here. Each resolves once to a destination (Node's Unix socket, or a
//! preview's upstream) and is relayed as it stands; an upgrade becomes a byte splice once the far side answers 101.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use front_wire::{
    Answer, FrontHeader, ListenConfig, PreviewRoute, Question, Scheme, TerminalPlan, Upstream,
};
use http::header::{self, HeaderMap, HeaderName, HeaderValue};
use http::request::Parts;
use http::{Method, Request, Response, StatusCode, Uri, Version};
use http_body_util::BodyExt;
use hyper::body::Incoming;
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use tokio::io::AsyncWriteExt;
use tokio::sync::watch;
use tower_service::Service;

use crate::body::{self, Body};
use crate::connect::{self, Io, NodeConnector, Pool, UpstreamConnector};
use crate::link::Link;
use crate::route::{self, Lane, Target};
use crate::term::{self, Terminals};

// A restarting Node is waited for this long before a request is answered 503; its sockets stay open meanwhile.
const NODE_PATIENCE: Duration = Duration::from_secs(30);

// A resolved preview upstream is served as is this long; a panel that stops is noticed within it.
const PREVIEW_ROUTE_FRESH: Duration = Duration::from_secs(1);

// Past fresh and within this, the route is still served while Node is asked again in the background, so a daemon stalled
// in a collection or a sync call never holds a preview's request; past it, the request waits for Node's answer.
const PREVIEW_ROUTE_STALE: Duration = Duration::from_secs(60);

// Past this many hosts the cache sheds what has gone stale; only hosts Node resolved to an upstream are ever held.
const PREVIEW_ROUTE_ROOM: usize = 256;

const ASK_PATIENCE: Duration = Duration::from_secs(5);

const TERMINAL_UPGRADES: &str = "a terminal opens as a WebSocket or an intentic-terminal upgrade";

// Never cross a hop: HTTP/1.1 connection management, and h2 refuses to carry them at all.
const HOP_BY_HOP: [&str; 9] = [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

// A declined upgrade's answer is re-framed onto the tunnel stream: its body is already de-chunked and ends at close.
const DECLINED_UPGRADE_DROP: [&str; 3] = ["connection", "keep-alive", "transfer-encoding"];

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
    Node {
        mark: Option<FrontHeader>,
        value: HeaderValue,
    },
    Upstream {
        upstream: Upstream,
        host: String,
        proto: &'static str,
        ancestors: Vec<String>,
    },
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
        lane: Lane,
        mut request: Request<Incoming>,
    ) -> Response<Body> {
        strip_front_headers(request.headers_mut());
        let host = host_of(&request);
        let destination = self.destination(lane, &host, request.uri().path()).await;
        if matches!(destination, Destination::Unavailable) {
            return unavailable();
        }
        if is_front_route(&destination, request.method(), request.uri().path()) {
            return self.terminal(request).await;
        }
        let upgrade = is_upgrade(request.headers(), request.version());
        let client = upgrade.then(|| hyper::upgrade::on(&mut request));
        let (mut parts, incoming) = request.into_parts();
        outbound(&destination, &mut parts, upgrade);
        let outbound = Request::from_parts(parts, body::incoming(incoming));
        if let Some(client) = client {
            return match self.dial_upgrade(&destination, outbound).await {
                Ok(answer) => relay_upgrade(answer, client),
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

    /// A request down the ingress tunnel: a CONNECT carries a WebSocket upgrade's h1 head under `x-ingress-*`.
    pub async fn tunnel(self: &Arc<Self>, request: Request<Incoming>) -> Response<Body> {
        if request.method() == Method::CONNECT {
            return self.tunnel_upgrade(request).await;
        }
        self.handle(Lane::Tunnel, request).await
    }

    // Answered 200 at once on the h2 stream; the far side's own answer then travels as raw h1 bytes on it.
    async fn tunnel_upgrade(self: &Arc<Self>, mut request: Request<Incoming>) -> Response<Body> {
        let stream = hyper::upgrade::on(&mut request);
        let Some(inner) = unwrap_envelope(request.headers()) else {
            return bad_request("an upgrade envelope names an unreadable method or header");
        };
        let host = host_of(&inner);
        let destination = self
            .destination(Lane::Tunnel, &host, inner.uri().path())
            .await;
        if matches!(destination, Destination::Unavailable) {
            return unavailable();
        }
        if is_front_route(&destination, inner.method(), inner.uri().path()) {
            let framing = term::Framing::of(inner.headers());
            let query = inner.uri().query().unwrap_or_default().to_owned();
            return self.tunnel_terminal(stream, framing, query).await;
        }
        let (mut parts, empty) = inner.into_parts();
        outbound(&destination, &mut parts, true);
        let mut answer = match self
            .dial_upgrade(&destination, Request::from_parts(parts, empty))
            .await
        {
            Ok(answer) => answer,
            Err(error) => return bad_gateway(&error.to_string()),
        };
        let switching = answer.status() == StatusCode::SWITCHING_PROTOCOLS;
        let head = serialize_head(&answer, switching);
        let far = switching.then(|| hyper::upgrade::on(&mut answer));
        tokio::spawn(async move {
            let Ok(stream) = stream.await else {
                return;
            };
            let mut stream = TokioIo::new(stream);
            if stream.write_all(&head).await.is_err() {
                return;
            }
            match far {
                Some(far) => {
                    if let Ok(far) = far.await {
                        let _ = tokio::io::copy_bidirectional(&mut stream, &mut TokioIo::new(far))
                            .await;
                    }
                }
                None => {
                    let mut body = answer.into_body();
                    while let Some(Ok(frame)) = body.frame().await {
                        if let Ok(data) = frame.into_data()
                            && stream.write_all(&data).await.is_err()
                        {
                            return;
                        }
                    }
                    let _ = stream.shutdown().await;
                }
            }
        });
        Response::new(body::empty())
    }

    async fn terminal(self: &Arc<Self>, mut request: Request<Incoming>) -> Response<Body> {
        let framing = match request.version() {
            Version::HTTP_11 => term::Framing::of(request.headers()),
            _ => None,
        };
        let Some(framing) = framing else {
            return plain(StatusCode::UPGRADE_REQUIRED, TERMINAL_UPGRADES);
        };
        let query = request.uri().query().unwrap_or_default().to_owned();
        let (plan, member) = match self.terminal_plan(&query).await {
            Ok(planned) => planned,
            Err(refusal) => return *refusal,
        };
        let upgrade = hyper::upgrade::on(&mut request);
        let terminals = self.terminals.clone();
        let switching = framing.switching();
        tokio::spawn(async move {
            if let Ok(upgraded) = upgrade.await {
                terminals
                    .serve(TokioIo::new(upgraded), &framing, plan, member, &query)
                    .await;
            }
        });
        switching
    }

    // The CONNECT stream is answered 200 at once; the 101 the browser reads then travels on it as raw h1.
    async fn tunnel_terminal(
        self: &Arc<Self>,
        stream: OnUpgrade,
        framing: Option<term::Framing>,
        query: String,
    ) -> Response<Body> {
        let Some(framing) = framing else {
            return bad_request(TERMINAL_UPGRADES);
        };
        let (plan, member) = match self.terminal_plan(&query).await {
            Ok(planned) => planned,
            Err(refusal) => return *refusal,
        };
        let terminals = self.terminals.clone();
        tokio::spawn(async move {
            let Ok(stream) = stream.await else {
                return;
            };
            let mut stream = TokioIo::new(stream);
            if stream.write_all(&framing.switching_head()).await.is_ok() {
                terminals
                    .serve(stream, &framing, plan, member, &query)
                    .await;
            }
        });
        Response::new(body::empty())
    }

    // Asked before the socket opens, so a daemon that cannot answer fails the upgrade and the browser retries.
    async fn terminal_plan(
        &self,
        query: &str,
    ) -> Result<(TerminalPlan, Option<String>), Box<Response<Body>>> {
        let asked = self
            .link
            .ask(
                Question::Terminal {
                    query: query.to_owned(),
                },
                ASK_PATIENCE,
            )
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

    async fn destination(self: &Arc<Self>, lane: Lane, host: &str, path: &str) -> Destination {
        let config = self.config.borrow().clone();
        let sandbox_id = config
            .as_deref()
            .and_then(|config| config.sandbox_id.as_deref());
        match route::target(lane, host, sandbox_id) {
            Target::Node => {
                self.node_destination(None, HeaderValue::from_static(""))
                    .await
            }
            Target::Preview => {
                let Some(config) = config else {
                    return Destination::Unavailable;
                };
                if path == config.preview_probe_path {
                    return self
                        .node_destination(
                            Some(FrontHeader::Preview),
                            HeaderValue::from_static("probe"),
                        )
                        .await;
                }
                match self.preview_route(host).await {
                    Ok(Some(upstream)) => Destination::Upstream {
                        upstream,
                        host: host.to_owned(),
                        proto: if lane == Lane::Tunnel {
                            "https"
                        } else {
                            "http"
                        },
                        ancestors: config.frame_ancestors.clone(),
                    },
                    Ok(None) => {
                        self.node_destination(
                            Some(FrontHeader::Preview),
                            HeaderValue::from_static("answer"),
                        )
                        .await
                    }
                    Err(error) => {
                        tracing::warn!(%error, host, "could not resolve a preview host");
                        Destination::Unavailable
                    }
                }
            }
        }
    }

    async fn node_destination(&self, mark: Option<FrontHeader>, value: HeaderValue) -> Destination {
        if self.link.ready(NODE_PATIENCE).await {
            Destination::Node { mark, value }
        } else {
            Destination::Unavailable
        }
    }

    async fn preview_route(self: &Arc<Self>, host: &str) -> anyhow::Result<Option<Upstream>> {
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
                return Ok(Some(upstream));
            }
        }
        self.resolve(host).await
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
            if let Err(error) = front.resolve(&host).await {
                tracing::debug!(%error, host, "a background preview refresh failed; the stale route stands");
            }
            front
                .refreshing
                .lock()
                .expect("refresh set poisoned")
                .remove(&host);
        });
    }

    async fn resolve(&self, host: &str) -> anyhow::Result<Option<Upstream>> {
        if !self.link.ready(NODE_PATIENCE).await {
            anyhow::bail!("the daemon is not up to resolve {host}");
        }
        let answer = self
            .link
            .ask(
                Question::Preview {
                    host: host.to_owned(),
                },
                ASK_PATIENCE,
            )
            .await?;
        let Answer::Preview { route } = answer else {
            anyhow::bail!("the daemon answered {host}'s route with {answer:?}");
        };
        let mut previews = self.previews.lock().expect("preview cache poisoned");
        match route {
            PreviewRoute::Upstream { upstream } => {
                if previews.len() >= PREVIEW_ROUTE_ROOM {
                    previews.retain(|_, (at, _)| at.elapsed() < PREVIEW_ROUTE_STALE);
                }
                previews.insert(host.to_owned(), (Instant::now(), upstream.clone()));
                Ok(Some(upstream))
            }
            PreviewRoute::Node => {
                previews.remove(host);
                Ok(None)
            }
        }
    }

    async fn dial_upgrade(
        &self,
        destination: &Destination,
        request: Request<Body>,
    ) -> anyhow::Result<Response<Incoming>> {
        let io: Io = match destination {
            Destination::Node { .. } => {
                self.node_connector
                    .clone()
                    .call(request.uri().clone())
                    .await?
            }
            _ => {
                self.upstream_connector
                    .clone()
                    .call(request.uri().clone())
                    .await?
            }
        };
        Ok(connect::send_upgrade(io, request).await?)
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
    matches!(destination, Destination::Node { mark: None, .. }) && term::serves(method, path)
}

fn host_of<B>(request: &Request<B>) -> String {
    request
        .uri()
        .authority()
        .map(|authority| authority.as_str().to_owned())
        .or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned)
        })
        .unwrap_or_default()
}

fn strip_front_headers(headers: &mut HeaderMap) {
    for front in FrontHeader::ALL {
        headers.remove(front.name());
    }
}

fn is_upgrade(headers: &HeaderMap, version: Version) -> bool {
    version <= Version::HTTP_11
        && headers.contains_key(header::UPGRADE)
        && headers
            .get_all(header::CONNECTION)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .any(|value| {
                value
                    .split(',')
                    .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
            })
}

// Also drops every header the Connection header names, as RFC 9110 asks of a proxy.
fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<HeaderName> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .filter_map(|token| HeaderName::from_bytes(token.trim().as_bytes()).ok())
        .collect();
    for name in named {
        headers.remove(name);
    }
    for name in HOP_BY_HOP {
        headers.remove(name);
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
    let upgrade_to = parts.headers.get(header::UPGRADE).cloned();
    strip_hop_by_hop(&mut parts.headers);
    if let (true, Some(upgrade_to)) = (upgrade, upgrade_to) {
        parts
            .headers
            .insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
        parts.headers.insert(header::UPGRADE, upgrade_to);
    }
    let path = parts
        .uri
        .path_and_query()
        .map_or("/", |path| path.as_str())
        .to_owned();
    let base = match destination {
        Destination::Node { mark, value } => {
            if let Some(mark) = mark {
                parts.headers.insert(mark.name(), value.clone());
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
        Destination::Unavailable => {
            unreachable!("an unavailable destination is answered before it is rewritten for")
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

fn relay_upgrade(mut answer: Response<Incoming>, client: OnUpgrade) -> Response<Body> {
    if answer.status() != StatusCode::SWITCHING_PROTOCOLS {
        return from_far_side(answer, None);
    }
    let far = hyper::upgrade::on(&mut answer);
    tokio::spawn(async move {
        if let (Ok(client), Ok(far)) = tokio::join!(client, far) {
            let _ =
                tokio::io::copy_bidirectional(&mut TokioIo::new(client), &mut TokioIo::new(far))
                    .await;
        }
    });
    let (parts, _) = answer.into_parts();
    Response::from_parts(parts, body::empty())
}

fn unwrap_envelope(headers: &HeaderMap) -> Option<Request<Body>> {
    let mut request = tunnel::unwrap_envelope(headers)?.map(|()| body::empty());
    strip_front_headers(request.headers_mut());
    Some(request)
}

// Written raw onto the browser's socket; header values are opaque octets, not UTF-8 text.
fn serialize_head(answer: &Response<Incoming>, switching: bool) -> Vec<u8> {
    let status = answer.status();
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    )
    .into_bytes();
    for (name, value) in answer.headers() {
        if !switching && DECLINED_UPGRADE_DROP.contains(&name.as_str()) {
            continue;
        }
        head.extend_from_slice(name.as_str().as_bytes());
        head.extend_from_slice(b": ");
        head.extend_from_slice(value.as_bytes());
        head.extend_from_slice(b"\r\n");
    }
    if !switching {
        head.extend_from_slice(b"connection: close\r\n");
    }
    head.extend_from_slice(b"\r\n");
    head
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

fn bad_request(message: &str) -> Response<Body> {
    plain(StatusCode::BAD_REQUEST, message)
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
    fn hop_by_hop_headers_and_the_ones_connection_names_are_dropped() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONNECTION,
            HeaderValue::from_static("keep-alive, x-private"),
        );
        headers.insert("x-private", HeaderValue::from_static("1"));
        headers.insert("keep-alive", HeaderValue::from_static("timeout=5"));
        headers.insert("x-kept", HeaderValue::from_static("1"));
        strip_hop_by_hop(&mut headers);
        assert_eq!(
            headers.keys().map(HeaderName::as_str).collect::<Vec<_>>(),
            vec!["x-kept"]
        );
    }

    #[test]
    fn an_envelope_rebuilds_the_h1_head_it_carried() {
        let mut headers = HeaderMap::new();
        headers.insert("x-ingress-method", HeaderValue::from_static("GET"));
        headers.insert(
            "x-ingress-path",
            HeaderValue::from_static("/system/terminal?ticket=t"),
        );
        headers.insert(
            "x-ingress-h-host",
            HeaderValue::from_static("sandbox-abcdef012345.sbx.example.test"),
        );
        headers.insert("x-ingress-h-upgrade", HeaderValue::from_static("websocket"));
        headers.insert(
            "x-ingress-h-connection",
            HeaderValue::from_static("Upgrade"),
        );
        headers.insert(
            "x-ingress-h-x-intentic-preview",
            HeaderValue::from_static("forged"),
        );
        headers.insert("x-unrelated", HeaderValue::from_static("dropped"));
        let request = unwrap_envelope(&headers).unwrap();
        assert_eq!(request.uri(), "/system/terminal?ticket=t");
        assert_eq!(host_of(&request), "sandbox-abcdef012345.sbx.example.test");
        assert!(is_upgrade(request.headers(), request.version()));
        assert!(!request.headers().contains_key("x-unrelated"));
        assert!(!request.headers().contains_key(FrontHeader::Preview.name()));
    }
}
