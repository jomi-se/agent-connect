//! Explicit proxy trust for admission budgets only; never authentication authority.
use anyhow::{Result, ensure};
use axum::http::{HeaderMap, HeaderName};
use serde::{
    Deserialize, Deserializer, Serialize,
    de::{MapAccess, Visitor},
};
use std::{
    collections::{BTreeMap, HashSet},
    fmt,
    net::{IpAddr, Ipv4Addr},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ClientAddressPolicy {
    pub header: String,
    pub trusted_peers: Vec<IpAddr>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct ClientAddressPolicies(BTreeMap<String, ClientAddressPolicy>);

// A normal map silently accepts duplicate JSON keys. Trust policy must not.
impl<'de> Deserialize<'de> for ClientAddressPolicies {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        struct Policies;
        impl<'de> Visitor<'de> for Policies {
            type Value = ClientAddressPolicies;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a map of configured origins to client address policies")
            }
            fn visit_map<A: MapAccess<'de>>(
                self,
                mut map: A,
            ) -> std::result::Result<Self::Value, A::Error> {
                let mut policies = BTreeMap::new();
                while let Some((origin, policy)) =
                    map.next_entry::<String, ClientAddressPolicy>()?
                {
                    if policies.insert(origin, policy).is_some() {
                        return Err(serde::de::Error::custom("duplicate client address policy"));
                    }
                }
                Ok(ClientAddressPolicies(policies))
            }
        }
        deserializer.deserialize_map(Policies)
    }
}

impl ClientAddressPolicies {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn validate<'a>(&mut self, origins: impl Iterator<Item = &'a str>) -> Result<()> {
        let origins: HashSet<_> = origins.collect();
        for (origin, policy) in &mut self.0 {
            ensure!(
                origins.contains(origin.as_str()),
                "client address policy must name a configured origin"
            );
            let header = HeaderName::from_bytes(policy.header.as_bytes())
                .map_err(|_| anyhow::anyhow!("invalid client address header name"))?;
            ensure!(
                !matches!(
                    header.as_str(),
                    "host"
                        | "origin"
                        | "referer"
                        | "cookie"
                        | "set-cookie"
                        | "authorization"
                        | "proxy-authorization"
                        | "www-authenticate"
                        | "proxy-authenticate"
                        | "connection"
                        | "content-length"
                        | "transfer-encoding"
                        | "upgrade"
                        | "te"
                        | "trailer"
                        | "keep-alive"
                        | "forwarded"
                        | "x-forwarded-host"
                        | "x-forwarded-proto"
                        | "x-forwarded-port"
                ),
                "reserved client address header name"
            );
            policy.header = header.as_str().to_owned();
            ensure!(
                !policy.trusted_peers.is_empty(),
                "client address policy requires trusted transport peers"
            );
            let mut peers = HashSet::new();
            for peer in &mut policy.trusted_peers {
                *peer = normalize(*peer);
                ensure!(peers.insert(*peer), "duplicate trusted transport peer");
            }
            policy.trusted_peers.sort();
        }
        Ok(())
    }

    // The caller has already selected an exact configured origin from one Host.
    pub(crate) fn source(
        &self,
        origin: &str,
        headers: &HeaderMap,
        peer: Option<IpAddr>,
    ) -> ClientSource {
        let peer = peer.map(normalize);
        let Some(policy) = self.0.get(origin) else {
            return ClientSource::Transport(peer);
        };
        if !peer.is_some_and(|peer| policy.trusted_peers.contains(&peer)) {
            return ClientSource::Transport(peer);
        }
        let mut values = headers.get_all(policy.header.as_str()).iter();
        let address = values.next().and_then(|value| {
            if values.next().is_some() {
                return None;
            }
            let text = value.to_str().ok()?.trim_matches([' ', '\t']);
            // IpAddr accepts bare IPv4/IPv6 only, not proxy chains, ports or zones.
            text.parse::<IpAddr>().ok().map(normalize)
        });
        match address {
            Some(ip) => ClientSource::Trusted(origin.to_owned(), ip),
            None => ClientSource::Missing(origin.to_owned()),
        }
    }
}

pub(crate) fn normalize(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(ip) => ip
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(ip)),
        ip => ip,
    }
}

// Deliberately not Serialize/Display: never emit client identifiers in audit/UI.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum ClientSource {
    Transport(Option<IpAddr>),
    Trusted(String, IpAddr),
    Missing(String),
    Overflow(Option<String>),
}
impl ClientSource {
    pub(crate) fn legacy(peer: Option<IpAddr>) -> Self {
        Self::Transport(Some(peer.unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED))))
    }
    pub(crate) fn reserved(&self) -> bool {
        matches!(self, Self::Missing(_) | Self::Overflow(_))
    }
    pub(crate) fn overflow(&self) -> Self {
        Self::Overflow(match self {
            Self::Trusted(origin, _) | Self::Missing(origin) => Some(origin.clone()),
            _ => None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;
    const ORIGIN: &str = "https://gateway.example";
    fn policies() -> ClientAddressPolicies {
        serde_json::from_value(
            serde_json::json!({ORIGIN: {"header":"X-Client-IP", "trusted_peers":["192.0.2.10"]}}),
        )
        .unwrap()
    }
    #[test]
    fn client_address_policy_validation_rejects_ambiguous_or_unsafe_configuration() {
        let mut valid = policies();
        valid.validate([ORIGIN].into_iter()).unwrap();
        assert_eq!(valid.0[ORIGIN].header, "x-client-ip");
        assert!(
            valid
                .validate(["https://other.example"].into_iter())
                .is_err()
        );
        for header in [
            "",
            "x ip",
            "x-ip\r\n",
            "Host",
            "Origin",
            "cookie",
            "Authorization",
            "Connection",
            "Content-Length",
            "Transfer-Encoding",
            "X-Forwarded-Proto",
            "Forwarded",
        ] {
            let mut invalid = policies();
            invalid.0.get_mut(ORIGIN).unwrap().header = header.into();
            assert!(
                invalid.validate([ORIGIN].into_iter()).is_err(),
                "{header:?}"
            );
        }
        for peers in [vec![], vec!["192.0.2.10", "::ffff:192.0.2.10"]] {
            let mut invalid = policies();
            invalid.0.get_mut(ORIGIN).unwrap().trusted_peers =
                peers.iter().map(|ip| ip.parse().unwrap()).collect();
            assert!(invalid.validate([ORIGIN].into_iter()).is_err());
        }
        for json in [
            r#"{"https://gateway.example":{"header":"x-ip","trusted_peers":["192.0.2.0/24"]}}"#,
            r#"{"https://gateway.example":{}}"#,
            r#"{"https://gateway.example":{"header":"x-ip","header":"x-other","trusted_peers":["192.0.2.10"]}}"#,
            r#"{"https://gateway.example":{"header":"x-ip","trusted_peers":["192.0.2.10"]},"https://gateway.example":{"header":"x-other","trusted_peers":["192.0.2.10"]}}"#,
            r#"{"https://gateway.example":{"header":"x-ip","trusted_peers":["192.0.2.10"],"unexpected":true}}"#,
        ] {
            assert!(serde_json::from_str::<ClientAddressPolicies>(json).is_err());
        }
    }
    #[test]
    fn client_address_header_requires_transport_trust_and_one_bare_ip() {
        let mut policies = policies();
        policies.validate([ORIGIN].into_iter()).unwrap();
        let trusted = Some("192.0.2.10".parse().unwrap());
        let mut headers = HeaderMap::new();
        headers.insert("x-client-ip", HeaderValue::from_static("198.51.100.7"));
        for peer in [None, Some("192.0.2.11".parse().unwrap())] {
            assert_eq!(
                policies.source(ORIGIN, &headers, peer),
                ClientSource::Transport(peer)
            );
        }
        assert_eq!(
            policies.source("https://unconfigured.example", &headers, trusted),
            ClientSource::Transport(trusted)
        );
        for text in ["198.51.100.7", "::ffff:198.51.100.7", " 198.51.100.7\t"] {
            headers.insert("x-client-ip", text.parse().unwrap());
            assert_eq!(
                policies.source(ORIGIN, &headers, trusted),
                ClientSource::Trusted(ORIGIN.into(), "198.51.100.7".parse().unwrap())
            );
        }
        headers.insert("x-client-ip", "2001:db8::1".parse().unwrap());
        assert_eq!(
            policies.source(ORIGIN, &headers, trusted),
            ClientSource::Trusted(ORIGIN.into(), "2001:db8::1".parse().unwrap())
        );
        for text in [
            "",
            "198.51.100.7, 198.51.100.8",
            "198.51.100.7:443",
            "[2001:db8::1]",
            "fe80::1%eth0",
            "secret-not-an-ip",
        ] {
            headers.insert("x-client-ip", text.parse().unwrap());
            assert_eq!(
                policies.source(ORIGIN, &headers, trusted),
                ClientSource::Missing(ORIGIN.into())
            );
        }
        headers.insert("x-client-ip", HeaderValue::from_bytes(&[0xff]).unwrap());
        assert_eq!(
            policies.source(ORIGIN, &headers, trusted),
            ClientSource::Missing(ORIGIN.into())
        );
        headers.insert("x-client-ip", "198.51.100.7".parse().unwrap());
        headers.append("x-client-ip", "198.51.100.7".parse().unwrap());
        assert_eq!(
            policies.source(ORIGIN, &headers, trusted),
            ClientSource::Missing(ORIGIN.into())
        );
        headers.remove("x-client-ip");
        assert_eq!(
            policies.source(ORIGIN, &headers, trusted),
            ClientSource::Missing(ORIGIN.into())
        );
        assert_eq!(
            policies.source(ORIGIN, &headers, Some("::ffff:192.0.2.10".parse().unwrap())),
            ClientSource::Missing(ORIGIN.into())
        );
    }
}
