//! Structured logs in OpenTelemetry's log data model, one JSON object per
//! line on stderr. Under systemd that is the journal; anything that reads
//! the OTel model (a collector's filelog or journald receiver) needs no
//! format of ours.
//!
//! Each record carries `timestamp`, `severity_text`, `severity_number`,
//! `body` (the event's message), `attributes` (its other fields, plus
//! `code.namespace` for the target) and `resource` (`service.name`,
//! `service.version`). Field names follow OTel's semantic conventions where
//! one exists (`session.id`, `network.peer.address`, `rpc.method`).
//!
//! Session content never enters a record: prompts, replies and tool payloads
//! appear only as a short preview (see [`preview`]).

use std::fmt;
use std::io::Write;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id};
use tracing::{Event, Level, Subscriber};
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

pub const SERVICE_NAME: &str = "agent-connect-gateway";

/// How much of a session message a log may show: enough to tell which
/// message it was, too little to carry its content.
pub const PREVIEW_CHARS: usize = 50;

/// The first [`PREVIEW_CHARS`] characters of `text`, marked when cut.
pub fn preview(text: &str) -> String {
    let mut chars = text.chars();
    let head: String = chars.by_ref().take(PREVIEW_CHARS).collect();
    if chars.next().is_some() {
        format!("{head}…")
    } else {
        head
    }
}

/// A layer that writes each event as one OTel log record.
pub struct OtelJson<W> {
    writer: W,
}

impl<W> OtelJson<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }
}

/// A span's fields, which every event inside it carries as attributes
/// (`session.id` on everything a session's policy handler logs).
struct SpanAttributes(Map<String, Value>);

impl<S, W> Layer<S> for OtelJson<W>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    W: for<'a> MakeWriter<'a> + 'static,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut fields = Fields::default();
        attrs.record(&mut fields);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut()
                .insert(SpanAttributes(fields.attributes));
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut inherited = Map::new();
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                if let Some(fields) = span.extensions().get::<SpanAttributes>() {
                    inherited.extend(fields.0.clone());
                }
            }
        }
        let mut line = record(event, inherited, SystemTime::now());
        line.push('\n');
        // A log that cannot be written must never take the gateway down.
        let _ = self.writer.make_writer().write_all(line.as_bytes());
    }
}

fn record(event: &Event<'_>, mut attributes: Map<String, Value>, now: SystemTime) -> String {
    let metadata = event.metadata();
    let mut fields = Fields::default();
    event.record(&mut fields);
    attributes.extend(fields.attributes);
    attributes.insert(
        "code.namespace".into(),
        Value::String(metadata.target().into()),
    );
    let (severity_text, severity_number) = severity(*metadata.level());
    serde_json::json!({
        "timestamp": rfc3339(now),
        "severity_text": severity_text,
        "severity_number": severity_number,
        "body": fields.body,
        "attributes": attributes,
        "resource": {
            "service.name": SERVICE_NAME,
            "service.version": env!("CARGO_PKG_VERSION"),
        },
    })
    .to_string()
}

/// OTel's severity numbers: the first of each level's range of four.
fn severity(level: Level) -> (&'static str, u8) {
    match level {
        Level::TRACE => ("TRACE", 1),
        Level::DEBUG => ("DEBUG", 5),
        Level::INFO => ("INFO", 9),
        Level::WARN => ("WARN", 13),
        Level::ERROR => ("ERROR", 17),
    }
}

#[derive(Default)]
struct Fields {
    body: String,
    attributes: Map<String, Value>,
}

impl Fields {
    fn put(&mut self, field: &Field, value: Value) {
        if field.name() == "message" {
            self.body = match value {
                Value::String(text) => text,
                other => other.to_string(),
            };
        } else {
            self.attributes.insert(field.name().into(), value);
        }
    }
}

impl Visit for Fields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.put(field, Value::String(value.into()));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.put(field, Value::Bool(value));
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.put(field, Value::from(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.put(field, Value::from(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.put(field, Value::from(value));
    }
    fn record_error(&mut self, field: &Field, value: &(dyn std::error::Error + 'static)) {
        self.put(field, Value::String(format!("{value:#}")));
    }
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.put(field, Value::String(format!("{value:?}")));
    }
}

/// `YYYY-MM-DDTHH:MM:SS.nnnnnnnnnZ`, in UTC.
fn rfc3339(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let seconds = since.as_secs();
    let (days, rest) = (seconds / 86_400, seconds % 86_400);
    let (year, month, day) = civil_from_days(days as i64);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:09}Z",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60,
        since.subsec_nanos()
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's
/// algorithm), so the gateway needs no date crate for one timestamp.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tracing_subscriber::prelude::*;

    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<u8>>>);
    impl Write for Capture {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn an_event_is_one_otel_log_record() {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::registry().with(OtelJson::new(move || writer.clone()));
        tracing::subscriber::with_default(subscriber, || {
            tracing::warn!(
                session.id = "s-1",
                attempts = 3_u64,
                ok = false,
                "box refresh failed: {}",
                "no network"
            );
        });
        let bytes = capture.0.lock().unwrap().clone();
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.lines().count(), 1, "one line per record: {text}");
        let record: Value = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(record["severity_text"], "WARN");
        assert_eq!(record["severity_number"], 13);
        assert_eq!(record["body"], "box refresh failed: no network");
        assert_eq!(record["attributes"]["session.id"], "s-1");
        assert_eq!(record["attributes"]["attempts"], 3);
        assert_eq!(record["attributes"]["ok"], false);
        assert_eq!(record["attributes"]["code.namespace"], module_path!());
        assert_eq!(record["resource"]["service.name"], SERVICE_NAME);
        assert!(record["timestamp"].as_str().unwrap().ends_with('Z'));
    }

    #[test]
    fn events_inside_a_span_carry_its_fields() {
        let capture = Capture::default();
        let writer = capture.clone();
        let subscriber = tracing_subscriber::registry().with(OtelJson::new(move || writer.clone()));
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!("acp", session.id = "s-2");
            let _entered = span.enter();
            tracing::info!(rpc.method = "session/new", "acp message");
        });
        let bytes = capture.0.lock().unwrap().clone();
        let record: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record["attributes"]["session.id"], "s-2");
        assert_eq!(record["attributes"]["rpc.method"], "session/new");
    }

    #[test]
    fn timestamps_are_utc_rfc3339() {
        let at = UNIX_EPOCH + Duration::new(1_793_966_400, 123);
        assert_eq!(rfc3339(at), "2026-11-06T12:00:00.000000123Z");
        assert_eq!(rfc3339(UNIX_EPOCH), "1970-01-01T00:00:00.000000000Z");
        // A leap day.
        let leap = UNIX_EPOCH + Duration::from_secs(951_782_400);
        assert_eq!(rfc3339(leap), "2000-02-29T00:00:00.000000000Z");
    }

    #[test]
    fn a_preview_is_bounded_and_marked_when_cut() {
        assert_eq!(preview("short"), "short");
        let long = "é".repeat(PREVIEW_CHARS + 10);
        let cut = preview(&long);
        assert_eq!(cut.chars().count(), PREVIEW_CHARS + 1);
        assert!(cut.ends_with('…'));
    }
}
