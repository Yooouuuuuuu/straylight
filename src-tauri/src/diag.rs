//! Self-diagnostics (incident 2026-07-29, docs/dev/incident-2026-07-29-engai01.md).
//!
//! Both defects in that incident were only visible from the *server's* journal —
//! which is backwards. This module keeps a small in-memory ring buffer of the
//! events that matter for connection forensics (channel opens/closes/leaks,
//! probe outcomes, reconnect attempts, recycles, CPU alarms), dumpable to a file
//! on demand, plus a CPU self-monitor that detects a pegged core and *reports*
//! it — it never acts on connections (a false positive during a heavy transfer
//! must not kill healthy sessions).

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use tauri::{AppHandle, Emitter, Manager};

/// Ring capacity: ~2000 events ≈ hours of normal churn, a few hundred KB worst
/// case. Old events fall off the front.
const CAPACITY: usize = 2000;

struct Event {
    at_millis: u64,
    /// `category: detail`, preformatted at push time (cheap, lock held briefly).
    line: String,
}

static EVENTS: OnceLock<Mutex<VecDeque<Event>>> = OnceLock::new();
/// Set once at startup so deep code (connection internals) can surface alerts
/// without threading an AppHandle everywhere.
static APP: OnceLock<AppHandle> = OnceLock::new();

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Install the app handle and start the CPU self-monitor. Called once in setup.
pub fn init(app: AppHandle) {
    let _ = APP.set(app.clone());
    event("diag", "diagnostics started");
    spawn_cpu_monitor(app);
}

/// Record one event: `category` is a short slug ("channel", "probe",
/// "reconnect", "recycle", "cpu"), `detail` the human line.
pub fn event(category: &str, detail: impl AsRef<str>) {
    let buf = EVENTS.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)));
    let mut buf = buf.lock().unwrap();
    if buf.len() >= CAPACITY {
        buf.pop_front();
    }
    buf.push_back(Event {
        at_millis: now_millis(),
        line: format!("{category}: {}", detail.as_ref()),
    });
}

/// Record an event AND surface it to the user as a toast (the frontend listens
/// on `diag-alert` and maps it to a notice). `level` is the toast level:
/// "info" | "warn" | "error".
pub fn alert(level: &str, message: impl AsRef<str>) {
    let message = message.as_ref();
    event("alert", message);
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "diag-alert",
            serde_json::json!({ "level": level, "message": message }),
        );
    }
}

/// Write the ring buffer to `logs/diag-<timestamp>.txt` in the app's log dir
/// and return the path (the palette's "Diagnostics: Save report").
#[tauri::command]
pub async fn diag_dump(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("no log dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create log dir: {e}"))?;
    let name = format!("diag-{}.txt", chrono::Local::now().format("%Y%m%d-%H%M%S"));
    let path = dir.join(name);

    let mut out = String::new();
    out.push_str(&format!(
        "Straylight diagnostics — {} (v{})\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        app.package_info().version
    ));
    {
        let buf = EVENTS
            .get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)))
            .lock()
            .unwrap();
        out.push_str(&format!("{} events, oldest first, local time.\n\n", buf.len()));
        for e in buf.iter() {
            let ts = chrono::DateTime::from_timestamp_millis(e.at_millis as i64)
                .map(|t| {
                    t.with_timezone(&chrono::Local)
                        .format("%H:%M:%S%.3f")
                        .to_string()
                })
                .unwrap_or_else(|| "??:??:??".into());
            out.push_str(&format!("{ts}  {}\n", e.line));
        }
    }
    std::fs::write(&path, out).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    let path = path.to_string_lossy().into_owned();
    event("diag", format!("report saved to {path}"));
    Ok(path)
}

/// Sustained-CPU tripwire (incident M5/M6, scoped to detect-and-report): if our
/// own process holds >85% of one core for 30s while no transfer is running,
/// something is spinning — capture it and tell the user once per session. The
/// incident's 99%-CPU defect was never reproduced in current code; this exists
/// so a recurrence is attributable from OUR side instead of a server journal.
fn spawn_cpu_monitor(app: AppHandle) {
    static ALERTED: AtomicBool = AtomicBool::new(false);
    const SAMPLE_SECS: u64 = 5;
    const HOT_SAMPLES: u32 = 6; // 6 × 5s = 30s sustained
    const HOT_FRACTION: f64 = 0.85;

    // `tauri::async_runtime::spawn`, NOT `tokio::spawn`: this is called from the
    // Tauri `setup()` hook, which runs on the main thread OUTSIDE the Tokio
    // runtime context — a bare `tokio::spawn` there panics ("no reactor running").
    tauri::async_runtime::spawn(async move {
        let mut last: Option<u64> = None; // cumulative CPU time, 100ns units
        let mut hot_streak = 0u32;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(SAMPLE_SECS)).await;
            let Some(now) = process_cpu_100ns() else {
                return; // unsupported platform — monitor off
            };
            let Some(prev) = last.replace(now) else {
                continue; // first sample = baseline
            };
            // Fraction of ONE core used over the window.
            let used = (now.saturating_sub(prev)) as f64 / (SAMPLE_SECS as f64 * 10_000_000.0);
            if used < HOT_FRACTION {
                hot_streak = 0;
                continue;
            }
            // A running transfer legitimately uses CPU (crypto) — not a spin.
            let state = app.state::<crate::AppState>();
            if !state.transfers.lock().await.is_empty() {
                hot_streak = 0;
                continue;
            }
            hot_streak += 1;
            event("cpu", format!("hot sample: {:.0}% of a core (streak {hot_streak})", used * 100.0));
            if hot_streak >= HOT_SAMPLES && !ALERTED.swap(true, Ordering::SeqCst) {
                alert(
                    "warn",
                    "Straylight has been using a full CPU core for 30s with no transfer \
                     running — a diagnostic marker was captured. Palette → \
                     \"Diagnostics: Save report\" writes the details to a file.",
                );
            }
        }
    });
}

/// Our process's cumulative CPU time (kernel + user) in 100ns units.
#[cfg(windows)]
fn process_cpu_100ns() -> Option<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, GetProcessTimes};
    unsafe {
        let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
        if GetProcessTimes(
            GetCurrentProcess(),
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        ) == 0
        {
            return None;
        }
        let k = ((kernel.dwHighDateTime as u64) << 32) | kernel.dwLowDateTime as u64;
        let u = ((user.dwHighDateTime as u64) << 32) | user.dwLowDateTime as u64;
        Some(k + u)
    }
}

#[cfg(not(windows))]
fn process_cpu_100ns() -> Option<u64> {
    None
}
