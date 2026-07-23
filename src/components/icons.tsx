/** Small inline SVG icons used throughout the chrome. All use `currentColor`
 *  so they inherit the surrounding text color. */

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none" as const,
    xmlns: "http://www.w3.org/2000/svg",
  };
}

/** Notification bell (status bar, right edge) — toast history lives behind it. */
export function IconBell({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 2.6c-2.3 0-3.8 1.7-3.8 3.9v2.4L3 10.8h10l-1.2-1.9V6.5c0-2.2-1.5-3.9-3.8-3.9Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6.7 12.8a1.35 1.35 0 0 0 2.6 0"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Chat bubble — the CHAT column's identity (status bar button, empty state). */
export function IconChatBubble({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M3 3h10a1.3 1.3 0 0 1 1.3 1.3v5.4A1.3 1.3 0 0 1 13 11H8.2L5 13.6V11H3a1.3 1.3 0 0 1-1.3-1.3V4.3A1.3 1.3 0 0 1 3 3Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Move this terminal into the CHAT column" — arrow driving into the bubble. */
export function IconToChat({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M5.6 4.6V4a1.2 1.2 0 0 1 1.2-1.2h6.6A1.2 1.2 0 0 1 14.6 4v5.4a1.2 1.2 0 0 1-1.2 1.2h-2.6L8 13v-2.4h-1.2a1.2 1.2 0 0 1-1.2-1.2v-.6"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M1 7h7M5.6 4.6 8 7l-2.4 2.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Dock-move: step a column toward the left/right slot (arrow to bar). */
export function IconToBar({
  size = 16,
  className,
  dir = "right",
}: IconProps & { dir?: "left" | "right" }) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      style={dir === "left" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M2 8h8.2M7 4.8 10.2 8 7 11.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M13 3.6v8.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Remove-from-here (the ＋'s twin): a chat resident returns to the panel.
 *  One of three distinct minus glyphs — this is the round-cap "chats" minus,
 *  paired with the ＋. (App minimize = the low IconMinimize; panel hide = the
 *  solid IconPanelHide bar.) */
export function IconMinus({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M3.6 8h8.8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Panel-hide minus — a solid centered SLAB, unmistakably heavier than the
 *  thin round-cap chat minus and the low app-minimize dash. Used by all four
 *  bottom-left panels (explorer, terminal, SC, CHAT). */
export function IconPanelHide({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect
        x="3.4"
        y="6.8"
        width="9.2"
        height="2.4"
        rx="0.7"
        fill="currentColor"
      />
    </svg>
  );
}

export function IconChevron({
  size = 16,
  className,
  dir = "right",
}: IconProps & { dir?: "right" | "down" }) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      style={dir === "down" ? { transform: "rotate(90deg)" } : undefined}
    >
      <path
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Pencil — commit/amend box toggle, renames. */
export function IconPencil({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="m3 13 .7-2.8 6.9-6.9a1.3 1.3 0 0 1 1.8 0l.3.3a1.3 1.3 0 0 1 0 1.8l-6.9 6.9L3 13Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path d="m9.7 4.2 2.1 2.1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Push (up). */
export function IconArrowUp({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 12.6V3.4M4.4 7 8 3.4 11.6 7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Fetch (down). */
export function IconArrowDown({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 3.4v9.2M4.4 9 8 12.6 11.6 9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Overflow menu (⋯). */
export function IconMore({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="3.6" cy="8" r="1.15" fill="currentColor" />
      <circle cx="8" cy="8" r="1.15" fill="currentColor" />
      <circle cx="12.4" cy="8" r="1.15" fill="currentColor" />
    </svg>
  );
}

/** Undo-arrow — discard changes, reset a keybinding to its default. */
export function IconUndo({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M6.3 3.8 3 7l3.3 3.2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 7h6.4a3.4 3.4 0 0 1 3.4 3.4v1.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Copy to clipboard (toast messages). */
export function IconCopy({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M6 3.2h6a.8.8 0 0 1 .8.8v6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <rect
        x="3.2"
        y="5.6"
        width="7.4"
        height="7.4"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

/** Checkmark (copied!). */
export function IconCheck({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M3.5 8.5 6.8 11.5 12.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** "Send this panel's content to the editor" — panel with an outgoing arrow. */
export function IconPanelToEditor({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v7A1.5 1.5 0 0 0 3.5 13h7a1.5 1.5 0 0 0 1.5-1.5V9"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M9 3h4v4M13 3 7.5 8.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** Ethernet jack (Ports tool group). */
export function IconEthernet({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M3 6h10v7H3zM5.5 3h5v3h-5z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M5.5 13v-2M8 13v-2M10.5 13v-2" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Cube (Containers tool group). */
export function IconCube({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 2 13.5 5v6L8 14 2.5 11V5L8 2ZM2.5 5 8 8l5.5-3M8 8v6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** Tunnel arrow (Forwarding tool group). */
export function IconTunnel({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M2 8h8M8 5l3 3-3 3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M12.5 3.5v9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/** Plain folder (status bar: Explorer). */
export function IconFolder({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 2h4.5A1.5 1.5 0 0 1 14 6.5v5A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5v-7Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Branch fork (status bar: Source Control). */
export function IconBranch({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <circle cx="4.5" cy="4" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="4.5" cy="12" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="11.5" cy="5.5" r="1.6" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.5 5.6v4.8M11.5 7.1c0 2.4-3 2.4-5.2 3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

/** Terminal prompt (status bar: Terminal). */
export function IconTerminalGlyph({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect
        x="2"
        y="3"
        width="12"
        height="10"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path
        d="M4.5 6.5 6.8 8.4 4.5 10.3M8 10.5h3.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

export function IconRefresh({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M13 8a5 5 0 1 1-1.46-3.54M13 3v2.5h-2.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Heartbeat / ECG — "this repo is monitored". */
export function IconPulse({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M1.5 8h3L6 4.5l3 7L10.5 8h4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Flatline — monitoring off. */
export function IconPulseOff({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M1.5 8h13"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconEye({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M2.5 12C4.6 7.7 8.1 5 12 5s7.4 2.7 9.5 7c-2.1 4.3-5.6 7-9.5 7s-7.4-2.7-9.5-7Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx="12"
        cy="12"
        r="3"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconEyeOff({ size = 16, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M2.5 10c2.1 3.2 5.6 5 9.5 5s7.4-1.8 9.5-5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 15v3.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M6.6 13.9 4.5 16.7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <path
        d="M17.4 13.9l2.1 2.8"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 3.5v9M3.5 8h9"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconFilePlus({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8.5 2.5H5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V6L8.5 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8.5 2.5V6H12"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 8.4v3.2M6.4 10h3.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconFolderPlus({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M2 5.5V4a1 1 0 0 1 1-1h3l1.4 1.7H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M8 8v3.2M6.4 9.6h3.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Stacked layers — "make a new group / collection". */
export function IconLayers({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 2.5 14 5.5 8 8.5 2 5.5 8 2.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 8 8 10.75 13.5 8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M2.5 10.5 8 13.25 13.5 10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconTransfer({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M3 5.5h8M8.5 3 11 5.5 8.5 8M13 10.5H5M7.5 8 5 10.5 7.5 13"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconClose({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Minimize sits at the BASELINE (Windows convention) so it can't be mistaken
 *  for the maximize square's midline at titlebar size. */
export function IconMinimize({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M4 11h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

export function IconMaximize({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <rect x="4" y="4" width="8" height="8" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

/** Restore-down: shown on the maximize button while the window IS maximized. */
export function IconRestore({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M6.2 3.8h5.2a.8.8 0 0 1 .8.8v5.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <rect
        x="3.8"
        y="6.2"
        width="6.4"
        height="6.4"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

export function IconTerminal({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M4 5.5L6.5 8 4 10.5M8.5 10.5H12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Connect: the plug seated flush on the wall — prongs hidden inside (contact
 *  made), one unbroken run of wall · body · cable. Pairs with IconUnplug. */
export function IconPlug({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M4.2 2.8v10.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M4.4 4.9h4.2a1.4 1.4 0 0 1 1.4 1.4v3.4a1.4 1.4 0 0 1-1.4 1.4H4.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M10 8h3.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Disconnect: the same plug pulled out — now the prongs show, plus the gap
 *  and two spark ticks. The host keeps running; only your cable comes out. */
export function IconUnplug({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M2.6 2.8v10.4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path
        d="M5 5.5 4 4.5M5 10.5l-1 1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M6.6 6.3h2M6.6 9.7h2"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path
        d="M8.6 4.9h3.2a1.4 1.4 0 0 1 1.4 1.4v3.4a1.4 1.4 0 0 1-1.4 1.4H8.6z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M13.2 8h1.8"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconDownload({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M8 2.5v7M5 6.5L8 9.5l3-3M3 12.5h10"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconExternal({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M9 3.5h3.5V7M12.5 3.5L7.5 8.5M11 9v3.5H3.5V5H7"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconBinaryFile({ size = 40, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      <path
        d="M12 6.5c0-1.1.9-2 2-2h12.6c.5 0 1 .2 1.4.6l8.9 8.9c.4.4.6.9.6 1.4V41.5c0 1.1-.9 2-2 2H14c-1.1 0-2-.9-2-2v-35Z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M26.5 4.8V13c0 1.1.9 2 2 2h8.2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <text
        x="24"
        y="34"
        textAnchor="middle"
        fontFamily="monospace"
        fontSize="8"
        fill="currentColor"
      >
        01
      </text>
    </svg>
  );
}
