//! Staged remote saves (docs/atomic-save.md): the server-side COMMIT step.
//!
//! The frontend has already uploaded the buffer to a `.straysave` temp next to
//! the target (plain SFTP — S1) and checked for save conflicts (S2). This
//! module dispatches S3: a **detached** server-local job that copies the temp
//! into the target's existing inode (`cp` — ownership/symlinks/hard links all
//! survive), verifies byte equality (`cmp`), and acknowledges through a marker
//! file. Detachment (`nohup` inside an inner `sh -c`) means sshd killing the
//! session on a connection drop cannot kill the commit — the job finishes
//! alone and the marker is found again on reconnect (S5).
//!
//! Marker discipline: the ok marker is written to a sidecar and `mv`ed into
//! place (an in-directory rename — a poller never sees a half-written marker)
//! and lands BEFORE the temp is removed, so "marker present" is always
//! trustworthy and "no marker" always means "not committed". On failure the
//! temp is KEPT — it may be the only complete copy of the user's data.

use tauri::State;

use crate::exec::{run_command, shell_quote};
use crate::AppState;

/// The commit script (POSIX sh), hash-guarded (atomic-save.md decision 11):
/// the target's current `sha256sum` must equal `expected_hash` or the job
/// refuses with a `changed` marker (target untouched, temp kept) — nothing
/// can be silently overwritten by an edit from elsewhere. `expected_hash`
/// `"-"` skips the guard (the conflict dialog's explicit Overwrite). `cp`
/// stderr is captured to a scratch file so the `fail` marker carries the
/// real reason; scratch and temp are cleaned on success, only the scratch on
/// failure.
fn commit_script(tmp: &str, orig: &str, ok: &str, err: &str, expected_hash: &str) -> String {
    let t = shell_quote(tmp);
    let o = shell_quote(orig);
    let k = shell_quote(ok);
    let kt = shell_quote(&format!("{ok}.t"));
    let e = shell_quote(err);
    let et = shell_quote(&format!("{err}.t"));
    let ec = shell_quote(&format!("{err}.c"));
    let x = shell_quote(expected_hash);
    format!(
        "cur=$(sha256sum < {o} 2>/dev/null | cut -d ' ' -f1) || cur=missing; \
         if [ {x} != - ] && [ \"$cur\" != {x} ]; \
         then printf changed > {et} && mv -f -- {et} {e}; \
         elif cp -- {t} {o} 2> {ec} && cmp -s -- {t} {o}; \
         then printf ok > {kt} && mv -f -- {kt} {k} && rm -f -- {t} {ec}; \
         else cat -- {ec} > {et} 2>/dev/null; printf fail >> {et}; \
         mv -f -- {et} {e}; rm -f -- {ec}; fi"
    )
}

/// Wrap the script so it survives the SSH session: the outer login shell only
/// parses `sh -c '<one quoted arg>'` (csh/noclobber-proof); all redirects and
/// the `&` live in POSIX sh; `nohup` shields the job from the session's HUP.
fn detached(inner: &str) -> String {
    format!("nohup sh -c {} </dev/null >/dev/null 2>&1 &", shell_quote(inner))
}

/// Dispatch the detached commit job for an uploaded `.straysave` temp. Returns
/// once the job is *started* (it acknowledges through the ok/err marker, which
/// the frontend polls over SFTP — S4). `dir` is the target's parent directory
/// (all paths are absolute; the cwd only anchors the exec).
#[tauri::command]
pub async fn save_commit(
    state: State<'_, AppState>,
    conn_id: String,
    dir: String,
    tmp: String,
    orig: String,
    ok_marker: String,
    err_marker: String,
    expected_hash: String,
) -> Result<(), String> {
    let wrapped = detached(&commit_script(
        &tmp,
        &orig,
        &ok_marker,
        &err_marker,
        &expected_hash,
    ));
    let out = run_command(&state, &conn_id, &dir, &["sh", "-c", &wrapped]).await?;
    if out.code != 0 {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            format!("could not start the save commit (exit {})", out.code)
        } else {
            msg.to_string()
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const H: &str = "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899";

    #[test]
    fn script_quotes_hostile_paths() {
        let s = commit_script(
            "/home/u/.a file.straysave.1",
            "/home/u/a file",
            "/home/u/.straysave.1.ok",
            "/home/u/.straysave.1.err",
            H,
        );
        // Paths with spaces arrive single-quoted, and `--` guards leading dashes.
        assert!(s.contains("cp -- '/home/u/.a file.straysave.1' '/home/u/a file'"));
        assert!(s.contains("cmp -s -- '/home/u/.a file.straysave.1'"));
        // An apostrophe in a path must use the '\'' escape, not break the quote.
        let s2 = commit_script("/x/it's.tmp", "/x/it's", "/x/ok", "/x/err", H);
        assert!(s2.contains("'/x/it'\\''s.tmp'"));
    }

    #[test]
    fn hash_guard_runs_before_the_copy() {
        let s = commit_script("/d/t", "/d/o", "/d/ok", "/d/err", H);
        // The guard hashes the CURRENT target and must be checked before cp.
        let hash = s.find("cur=$(sha256sum < '/d/o'").expect("target hashed");
        let guard = s.find(&format!("[ \"$cur\" != '{H}' ]")).expect("guard compares");
        let copy = s.find("cp -- '/d/t' '/d/o'").expect("copy");
        assert!(hash < guard && guard < copy);
        // A refusal writes the `changed` marker atomically and never touches cp.
        assert!(s.contains("printf changed > '/d/err.t' && mv -f -- '/d/err.t' '/d/err'"));
        // Force ("-") skips the guard by construction: '-' != - is false.
        let f = commit_script("/d/t", "/d/o", "/d/ok", "/d/err", "-");
        assert!(f.contains("[ '-' != - ]"));
    }

    #[test]
    fn marker_lands_before_temp_removal() {
        let s = commit_script("/d/t", "/d/o", "/d/ok", "/d/err", H);
        // "no marker = not committed" requires: mv-marker THEN rm-temp.
        let mv_ok = s.find("mv -f -- '/d/ok.t' '/d/ok'").expect("atomic ok move");
        let rm_tmp = s.find("rm -f -- '/d/t'").expect("temp cleanup");
        assert!(mv_ok < rm_tmp);
        // Neither failure branch removes the temp (it may be the only copy).
        // Changed branch = between its printf and the elif; fail branch = from
        // its printf to the end (only the stderr scratch is cleaned there).
        let changed_start = s.find("printf changed").expect("changed branch");
        let changed_end = s.find("elif").expect("elif follows");
        assert!(changed_start < changed_end);
        assert!(!s[changed_start..changed_end].contains("rm -f"));
        let fail_part = &s[s.find("printf fail").expect("fail branch")..];
        assert!(!fail_part.contains("rm -f -- '/d/t'"));
        assert!(fail_part.contains("rm -f -- '/d/err.c'"));
    }

    #[test]
    fn detachment_shape() {
        let w = detached("echo hi");
        // nohup + inner sh -c + full stdio detach + background — all required
        // for the job to survive the SSH session ending mid-commit.
        assert!(w.starts_with("nohup sh -c 'echo hi'"));
        assert!(w.contains("</dev/null"));
        assert!(w.contains(">/dev/null 2>&1"));
        assert!(w.ends_with("&"));
    }
}
