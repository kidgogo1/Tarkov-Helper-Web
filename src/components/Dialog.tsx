import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";

import { IconButton } from "./IconButton";

interface DialogProps {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

export function Dialog({
  open,
  title,
  description,
  children,
  footer,
  onClose,
  wide = false,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      aria-describedby={description ? `${title}-description` : undefined}
      aria-labelledby={`${title}-title`}
      className={wide ? "app-dialog wide" : "app-dialog"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      ref={dialogRef}
    >
      <header>
        <div>
          <h2 id={`${title}-title`}>{title}</h2>
          {description ? <p id={`${title}-description`}>{description}</p> : null}
        </div>
        <IconButton label="닫기" onClick={onClose}>
          <X aria-hidden="true" size={19} />
        </IconButton>
      </header>
      <div className="dialog-body">{children}</div>
      {footer ? <footer>{footer}</footer> : null}
    </dialog>
  );
}

