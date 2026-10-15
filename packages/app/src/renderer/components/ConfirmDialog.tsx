import { useEffect, useRef, type ReactNode } from 'react';

/**
 * A question with two buttons, in a native modal `<dialog>`: the browser traps focus, closes it on
 * Esc and gives focus back, and (unlike a script-injected overlay) it needs no inline styles, which
 * the app's content security policy forbids. The safe button comes first and has the focus, so
 * Enter never confirms by accident.
 */
export function ConfirmDialog({
  title,
  children,
  safeLabel,
  confirmLabel,
  onConfirm,
  onClose,
  danger = false,
}: {
  title: string;
  children: ReactNode;
  safeLabel: string;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
}) {
  const box = useRef<HTMLDialogElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el === null || el.open) return;
    // jsdom has no showModal; a real window always does.
    if (typeof el.showModal === 'function') el.showModal();
    else el.setAttribute('open', '');
    safe.current?.focus();
  }, []);
  return (
    <dialog
      ref={box}
      className="dialog"
      aria-labelledby="confirm-title"
      onCancel={(e) => {
        e.preventDefault(); // Esc: close through our own state
        onClose();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <div>{children}</div>
      <div className="form-actions">
        <button type="button" className="btn" ref={safe} onClick={onClose}>
          {safeLabel}
        </button>
        <button
          type="button"
          className={danger ? 'btn btn-danger' : 'btn btn-primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
