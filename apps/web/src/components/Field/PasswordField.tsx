import { useState } from "react";
import { Field, type FieldProps } from "./Field";

export function PasswordField(props: Omit<FieldProps, "type" | "endAdornment">) {
  const [visible, setVisible] = useState(false);

  return (
    <Field
      {...props}
      type={visible ? "text" : "password"}
      endAdornment={
        <button type="button" className="field__toggle" onClick={() => setVisible((v) => !v)}>
          {visible ? "Скрыть" : "Показать"}
        </button>
      }
    />
  );
}
