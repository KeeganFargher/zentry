// Things drawn over the page: toasts, the confirmation dialog, drop-down
// menus and copy buttons.

import { useEffect, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";

import { Icon } from "~/components/icons";
import { copyText, dismiss, useToasts } from "~/lib/toast";

export function Toasts(): JSX.Element {
  const toasts = useToasts();

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((entry) => (
        <div key={entry.id} className="toast">
          <span>{entry.message}</span>
          {entry.undo !== null && (
            <button
              type="button"
              className="plain"
              onClick={() => {
                entry.undo?.();
                dismiss(entry.id);
              }}
            >
              Undo
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export type Confirmation = {
  title: string;
  message: ReactNode;
  confirm: string;
  danger?: boolean;
  onConfirm: () => void;
};

type DialogProps = { request: Confirmation | null; onClose: () => void };

/** A modal question with Cancel and one action. Escape or Cancel closes it. */
export function ConfirmDialog({ request, onClose }: DialogProps): JSX.Element | null {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (request !== null && dialog.current?.open === false) {
      dialog.current.showModal();
    }
  }, [request]);

  if (request === null) {
    return null;
  }

  const accept = (): void => {
    request.onConfirm();
    onClose();
  };

  return (
    <dialog ref={dialog} className="confirm" onClose={onClose}>
      <h2>{request.title}</h2>
      <div className="confirm-message">{request.message}</div>
      <div className="confirm-actions">
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className={request.danger === true ? "primary danger" : "primary"}
          onClick={accept}
        >
          {request.confirm}
        </button>
      </div>
    </dialog>
  );
}

/** State for a page that asks before acting. */
export function useConfirm(): [ask: (request: Confirmation) => void, dialog: JSX.Element | null] {
  const [request, setRequest] = useState<Confirmation | null>(null);

  return [
    setRequest,
    <ConfirmDialog key="confirm" request={request} onClose={() => setRequest(null)} />,
  ];
}

export type MenuItem = { label: string; onSelect: () => void; danger?: boolean };

type MenuProps = { label: string; items: MenuItem[]; children: ReactNode };

/** A button that opens a short list of actions. */
export function Menu({ label, items, children }: MenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const close = (event: PointerEvent): void => {
      if (event.target instanceof Node && root.current?.contains(event.target) !== true) {
        setOpen(false);
      }
    };

    if (open) {
      document.addEventListener("pointerdown", close);
    }

    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  return (
    <div className="menu" ref={root}>
      <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        {children}
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger === true ? "danger" : undefined}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type CopyProps = { text: string; message: string; label?: string };

export function CopyButton({ text, message, label = "Copy" }: CopyProps): JSX.Element {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        void copyText(text, message);
      }}
    >
      <Icon name="copy" size={14} />
    </button>
  );
}
