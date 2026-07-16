/** The keyboard contract every popup shares — apply with:
 *
 *    const dlg = useDialogKeys(onCancel, isOpen);
 *    <div className="modal" ref={dlg.ref} onKeyDown={dlg.onKeyDown} …>
 *
 *  and mark the confirm button `data-dialog-primary`. You get:
 *  - focus moves INTO the dialog on open (the primary button, else the first
 *    control) and returns to where it was on close — no more keys landing in
 *    the tree/editor underneath;
 *  - Enter activates the focused control (a focused button fires natively;
 *    in a text field or on a checkbox it clicks the primary);
 *  - Esc cancels, whatever is focused;
 *  - Tab / Shift+Tab and ← / → cycle the dialog's buttons/checkboxes/fields,
 *    wrapping (arrows skip text fields, where they must move the caret);
 *  - Space toggles a focused checkbox (native);
 *  - every other key stops at the dialog — global shortcuts can't reach the
 *    app below.
 *
 *  Child elements' own React onKeyDown handlers run first (virtual bubbling),
 *  so a dialog can still special-case keys on a specific input. */
import { useLayoutEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isTextField(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "range"].includes(el.type);
  }
  return false;
}

export function useDialogKeys(
  onCancel: () => void,
  /** Truthy while the dialog is open — focus is (re)captured when this
   *  becomes a new truthy value and restored when it goes away. */
  active: unknown = true,
  opts?: {
    /** Pass false when the dialog places its own initial focus (e.g. the
     *  connect form's smart host/user/password choice). Trap, keys, and
     *  focus-restore still apply. */
    initialFocus?: boolean;
  },
): {
  ref: RefObject<HTMLDivElement>;
  onKeyDown: (e: React.KeyboardEvent) => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const placeFocus = opts?.initialFocus !== false;

  // Capture focus on open, give it back on close.
  useLayoutEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;
    const before = document.activeElement as HTMLElement | null;
    if (placeFocus) {
      // A disabled primary (e.g. Create with an empty name) can't take focus —
      // fall to the first control (usually the text field).
      const primary = root.querySelector<HTMLElement>("[data-dialog-primary]");
      const first = root.querySelector<HTMLElement>(FOCUSABLE);
      const target = primary && !primary.matches(":disabled") ? primary : first;
      (target ?? root).focus();
    }
    return () => {
      if (before?.isConnected) before.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const root = ref.current;
    if (!root) return;
    // The dialog owns the keyboard from here down — global shortcuts (window
    // listeners) never see keys typed while it's open.
    e.stopPropagation();

    if (e.key === "Escape") {
      e.preventDefault();
      cancelRef.current();
      return;
    }

    const focused = document.activeElement;
    if (e.key === "Enter") {
      // A focused button fires natively; from anywhere else Enter means
      // "confirm" (unless a child input already handled it and stopped).
      if (!(focused instanceof HTMLButtonElement) && !(focused instanceof HTMLTextAreaElement)) {
        const primary = root.querySelector<HTMLElement>("[data-dialog-primary]");
        if (primary) {
          e.preventDefault();
          primary.click();
        }
      }
      return;
    }

    const cycling =
      e.key === "Tab" ||
      ((e.key === "ArrowRight" || e.key === "ArrowLeft") && !isTextField(focused));
    if (!cycling) return;

    const list = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (el) => el.offsetParent !== null,
    );
    if (list.length === 0) return;
    const dir = e.key === "ArrowLeft" || (e.key === "Tab" && e.shiftKey) ? -1 : 1;
    const idx = list.indexOf(focused as HTMLElement);
    e.preventDefault();
    list[(Math.max(idx, 0) + dir + list.length) % list.length].focus();
  };

  return { ref, onKeyDown };
}
