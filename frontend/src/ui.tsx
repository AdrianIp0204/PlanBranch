import {
  cloneElement,
  isValidElement,
  useId,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
export function Dialog({
  title,
  children,
  onClose,
  className,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Capture before a child control's React autoFocus moves focus into the dialog.
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const backdropPress = useRef(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const requestedFocus = dialog.contains(document.activeElement)
      ? (document.activeElement as HTMLElement)
      : dialog.querySelector<HTMLElement>(
          '[autofocus], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
        );
    if (!dialog.open) dialog.showModal();
    // React autoFocus may run while the native dialog is still closed.
    // Focus its editable field only after showModal makes it focusable.
    requestedFocus?.focus({ preventScroll: true });
    return () => {
      if (dialog.open) dialog.close();
      if (returnFocus.current?.isConnected)
        returnFocus.current.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onPointerDown={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        backdropPress.current =
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom);
      }}
      onClick={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          backdropPress.current &&
          event.target === event.currentTarget &&
          (event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom)
        )
          onClose();
        backdropPress.current = false;
      }}
    >
      <div className="dialog-title">
        <h2>{title}</h2>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  const generatedId = useId();
  if (!isValidElement<Record<string, unknown>>(children))
    throw new Error("A field must contain a form control.");
  const id =
    typeof children.props.id === "string" ? children.props.id : generatedId;
  const description = [
    children.props["aria-describedby"],
    hint ? `${id}-hint` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        "aria-describedby": description || undefined,
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-mark" aria-hidden="true">
        ◇
      </div>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
export function ErrorMessage({ message }: { message: string }) {
  return message ? (
    <div className="error-message" role="alert">
      {message}
    </div>
  ) : null;
}
export function StatusMark({ status }: { status: string }) {
  return <span className={`status-mark ${status}`} aria-hidden="true" />;
}
