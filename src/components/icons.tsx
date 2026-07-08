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

export function IconChevron({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
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

/** Double chevron for collapsing a side panel ("minimize"). `dir` points the
 *  way the panel slides away — left for the explorer, right for Source
 *  Control. Both panels use this instead of an ×. */
export function IconPanelCollapse({
  size = 16,
  className,
  dir = "left",
}: IconProps & { dir?: "left" | "right" }) {
  return (
    <svg
      {...svgProps(size)}
      className={className}
      style={dir === "right" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M8 4L4 8l4 4M12 4L8 8l4 4"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
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

export function IconEye({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M1.5 8S3.8 3.5 8 3.5 14.5 8 14.5 8 12.2 12.5 8 12.5 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export function IconEyeOff({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M6.3 6.3A1.8 1.8 0 0 0 8 9.8M3 3l10 10M4.8 4.9C2.9 5.9 1.5 8 1.5 8s2.3 4.5 6.5 4.5c1 0 1.9-.2 2.7-.6M9.5 4c4 .6 5 4 5 4s-.5 1-1.4 2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
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

export function IconMinimize({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path d="M4 8.5h8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
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

export function IconPlug({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M9.5 2.5L7 5m4.5-.5L9.5 6.5M6.5 6.5L4 9l3 3 2.5-2.5M2.5 13.5L5 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconLogout({ size = 16, className }: IconProps) {
  return (
    <svg {...svgProps(size)} className={className}>
      <path
        d="M9.5 3.5H4.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M7.5 8h6M11 5.5L13.5 8 11 10.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
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
