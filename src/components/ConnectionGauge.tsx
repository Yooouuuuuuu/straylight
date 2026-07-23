/** Connection tally in the title bar, positioned over the explorer's section
 *  toggles: WSL sessions as a small floating cluster centered over the **W**
 *  button, remotes centered over **R** (max 3 each). Connected = neutral,
 *  connecting/reconnecting = amber pulse, disconnected = stable red. Local is
 *  never counted. The W/R x-positions come from --gauge-w-x / --gauge-r-x
 *  (derived from the sidebar width on .app), so it tracks explorer resizing. */
import { useAppStore } from "../store/appStore";
import { Tip } from "./Tooltip";

const H = 14; // floating cluster height (title bar is taller — it doesn't touch)
const SLANT = 5; // diagonal lean (keeps an up/down read, modern)
const ADV = 5; // step between strokes

type Host = { label: string; state: string };

function Group({ hosts, cls }: { hosts: Host[]; cls: string }) {
  if (hosts.length === 0) return null;
  const w = hosts.length * ADV + SLANT;
  const tip = hosts
    .map((h) => (h.state === "connected" ? h.label : `${h.label} (${h.state})`))
    .join(", ");
  return (
    <div className={`conns-group ${cls}`}>
      <Tip label={tip}>
        <svg
          className="conns-gauge"
          width={w}
          height={H}
          viewBox={`0 0 ${w} ${H}`}
          aria-hidden
        >
          {hosts.map((h, i) => (
            <line
              key={i}
              className={
                h.state === "connected"
                  ? undefined
                  : h.state === "disconnected"
                    ? "conns-gauge--down"
                    : "conns-gauge--active"
              }
              x1={i * ADV + 1}
              y1={H - 2}
              x2={i * ADV + 1 + SLANT}
              y2={2}
            />
          ))}
        </svg>
      </Tip>
    </div>
  );
}

export function ConnectionGauge() {
  const wsls = useAppStore((s) => s.wsls);
  const remotes = useAppStore((s) => s.remotes);

  const wslHosts: Host[] = wsls
    .slice(0, 3)
    .map((w) => ({ label: w.conn.name, state: w.state }));
  const remoteHosts: Host[] = remotes
    .slice(0, 3)
    .map((r) => ({ label: `${r.conn.user}@${r.conn.host}`, state: r.state }));

  return (
    <>
      <Group hosts={wslHosts} cls="conns-group--wsl" />
      <Group hosts={remoteHosts} cls="conns-group--remote" />
    </>
  );
}
