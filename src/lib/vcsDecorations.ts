/** Shared mapping from a VCS change kind to its tree/badge letter + CSS class,
 *  used by the file tree and the Source Control panel. */

/** Single-letter badge for a change kind ("" for the ancestor "child" marker). */
export function vcsLetter(kind: string): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "typechange":
      return "T";
    case "conflicted":
      return "!";
    case "untracked":
      return "U";
    default:
      return "";
  }
}

/** CSS color class for a change kind (e.g. `vcs--modified`). */
export function vcsClass(kind: string): string {
  return `vcs--${kind}`;
}
