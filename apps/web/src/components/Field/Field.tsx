import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import "./Field.css";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
  endAdornment?: ReactNode;
  ref?: Ref<HTMLInputElement>;
};

// Совместим с react-hook-form: register() отдаёт name, onChange, onBlur и ref
export function Field({ label, hint, error, endAdornment, ref, ...input }: FieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const message = error ?? hint;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className={error ? "field__control field__control--invalid" : "field__control"}>
        <input
          id={id}
          ref={ref}
          className="field__input"
          aria-invalid={error ? true : undefined}
          aria-describedby={message ? messageId : undefined}
          {...input}
        />
        {endAdornment}
      </div>
      {message && (
        <p id={messageId} className={error ? "field__error" : "field__hint"} role={error ? "alert" : undefined}>
          {message}
        </p>
      )}
    </div>
  );
}
