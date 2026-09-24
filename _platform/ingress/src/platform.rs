//! The one client the edge asks the platform with, over HTTPS on the internet or plain HTTP on a private network.

use std::sync::Arc;

use bytes::Bytes;
use http_body_util::Empty;
use hyper_rustls::HttpsConnector;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

pub type PlatformClient = Client<HttpsConnector<HttpConnector>, Empty<Bytes>>;

pub fn client() -> PlatformClient {
    let connector = hyper_rustls::HttpsConnectorBuilder::new()
        .with_provider_and_webpki_roots(Arc::new(rustls::crypto::ring::default_provider()))
        .expect("ring supports the default protocol versions")
        .https_or_http()
        .enable_http1()
        .build();
    Client::builder(TokioExecutor::new()).build(connector)
}
