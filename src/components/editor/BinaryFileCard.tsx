/** Shown instead of the editor for binary files. Phase 1 displays metadata;
 *  download / open-with-default actions arrive with the transfer queue in
 *  Phase 2. */
import { formatSize, formatTimestamp } from "../../lib/format";
import type { OpenFile } from "../../store/appStore";
import { IconBinaryFile } from "../icons";

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toUpperCase() : "Unknown";
}

export function BinaryFileCard({ file }: { file: OpenFile }) {
  return (
    <div className="binary-card">
      <div className="binary-card__icon">
        <IconBinaryFile size={56} />
      </div>
      <div className="binary-card__title">{file.name}</div>
      <dl className="binary-card__meta">
        <dt>Type</dt>
        <dd>{extensionOf(file.name)} (binary)</dd>
        <dt>Size</dt>
        <dd>{formatSize(file.size)}</dd>
        <dt>Modified</dt>
        <dd>{formatTimestamp(file.modified)}</dd>
        <dt>Path</dt>
        <dd>{file.path}</dd>
      </dl>
      <div className="conn-empty" style={{ maxWidth: 360 }}>
        This is a binary file, so it isn’t shown in the editor. Download and
        open-in-app support arrives in Phase 2.
      </div>
    </div>
  );
}
