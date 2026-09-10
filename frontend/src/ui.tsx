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
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog ref={ref} onCancel={onClose}>
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
