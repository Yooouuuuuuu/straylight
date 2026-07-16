/** "Properties" — name, kind, location, size, and metadata for the selection.
 *  Folder/multi-select size is computed recursively (shown as "Calculating…"
 *  until it returns). Matches Windows Explorer's Properties behaviour. */
import { useEffect, useState, type ReactNode } from "react";

import {
  basename,
  dirname,
  formatSize,
  formatTimestamp,
} from "../../lib/format";
import {
  fsEntryMeta,
  fsMeasure,
  type FileEntry,
  type PropertiesInfo,
} from "../../lib/ipc";
import { useDialogKeys } from "../../hooks/useDialogKeys";
import { useAppStore } from "../../store/appStore";
import { IconClose } from "../icons";

function kindLabel(m: FileEntry): string {
  if (m.isSymlink) return m.isDir ? "Symlink → folder" : "Symlink";
  if (m.isDir) return "Folder";
  const dot = m.name.lastIndexOf(".");
  const ext = dot > 0 ? m.name.slice(dot + 1) : "";
  return ext ? `File · .${ext}` : "File";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="props__row">
      <span className="props__key">{label}</span>
      <span className="props__val">{children}</span>
    </div>
  );
}

export function PropertiesDialog() {
  const nodes = useAppStore((s) => s.propertiesFor);
  const close = useAppStore((s) => s.closeProperties);
  const [meta, setMeta] = useState<FileEntry | null>(null);
  const [info, setInfo] = useState<PropertiesInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const single = nodes && nodes.length === 1 ? nodes[0] : null;
  const connId = nodes && nodes.length ? nodes[0].connId : null;
  const dlg = useDialogKeys(close, nodes);

  // Single-item detail (fast).
  useEffect(() => {
    setMeta(null);
    if (!single || !connId) return;
    let active = true;
    fsEntryMeta(connId, single.path)
      .then((m) => active && setMeta(m))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [single, connId]);

  // Recursive size + counts (may be slow — shown as "Calculating…").
  useEffect(() => {
    setInfo(null);
    setError(null);
    if (!nodes || !connId) return;
    let active = true;
    fsMeasure(
      connId,
      nodes.map((n) => n.path),
    )
      .then((i) => active && setInfo(i))
      .catch((e) => active && setError(String(e)));
    return () => {
      active = false;
    };
  }, [nodes, connId]);

  if (!nodes || nodes.length === 0) return null;

  const multi = nodes.length > 1;
  const hasFolder = nodes.some((n) => n.isDir);
  const title = single ? basename(single.path) : `${nodes.length} items`;

  const sizeText = error
    ? "—"
    : info
      ? `${formatSize(info.bytes)}${info.bytes >= 1024 ? ` (${info.bytes.toLocaleString()} bytes)` : ""}`
      : "Calculating…";
  const containsText = error
    ? "—"
    : info
      ? `${info.files} file${info.files === 1 ? "" : "s"}, ${info.folders} folder${info.folders === 1 ? "" : "s"}`
      : "Calculating…";

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal"
        style={{ width: "min(460px, 92vw)" }}
        role="dialog"
        aria-modal="true"
        ref={dlg.ref}
        onKeyDown={dlg.onKeyDown}
      >
        <div className="modal__header">
          <span className="modal__title">Properties</span>
          <button
            className="icon-btn"
            data-dialog-primary
            onClick={close}
            title="Close"
          >
            <IconClose />
          </button>
        </div>
        <div className="modal__body">
          <div className="props">
            <Row label={multi ? "Selection" : "Name"}>
              <span className="props__name" title={single?.path}>
                {title}
              </span>
            </Row>

            {single && (
              <Row label="Kind">
                {meta ? kindLabel(meta) : single.isDir ? "Folder" : "File"}
              </Row>
            )}

            {single && (
              <Row label="Location">
                <span className="props__mono" title={dirname(single.path)}>
                  {dirname(single.path) || "—"}
                </span>
              </Row>
            )}

            {meta?.isSymlink && meta.symlinkTarget && (
              <Row label="Links to">
                <span className="props__mono">{meta.symlinkTarget}</span>
              </Row>
            )}

            <Row label="Size">{sizeText}</Row>

            {(multi || hasFolder) && <Row label="Contains">{containsText}</Row>}

            {single && meta && (
              <Row label="Modified">{formatTimestamp(meta.modified)}</Row>
            )}

            {single && meta && (
              <Row label="Permissions">
                <span className="props__mono">{meta.permissions || "—"}</span>
              </Row>
            )}

            {single && meta && (meta.owner || meta.group) && (
              <Row label="Owner · Group">
                {[meta.owner, meta.group].filter(Boolean).join(" · ")}
              </Row>
            )}
          </div>
          {error && <div className="modal__error">{error}</div>}
        </div>
        <div className="modal__footer">
          <button className="btn btn--primary" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
