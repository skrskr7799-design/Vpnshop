import { FormField, Input, PasswordInput } from "@vpn/ui";
import type { InputHTMLAttributes } from "react";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ label, hint, error, ...input }: FieldProps) {
  return <FormField label={label} hint={hint} error={error}>{field => <Input {...input} {...field} />}</FormField>;
}
export function PasswordField({ label, hint, error, ...input }: Omit<FieldProps, "type">) {
  return <FormField label={label} hint={hint} error={error}>{field => <PasswordInput {...input} {...field} />}</FormField>;
}
