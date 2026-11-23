import { FormField, Icon, Input, PasswordInput, type IconName } from "@vpn/ui";
import type { InputHTMLAttributes, ReactNode } from "react";

export type FieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "id"> & {
  label: string;
  hint?: string;
  error?: string;
  icon?: IconName;
};

function WithIcon({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return icon ? <span className="mz-input-icon"><Icon name={icon} size={19} />{children}</span> : children;
}
export function Field({ label, hint, error, icon, ...input }: FieldProps) {
  return <FormField label={label} hint={hint} error={error}>{field => <WithIcon icon={icon}><Input {...input} {...field} /></WithIcon>}</FormField>;
}
export function PasswordField({ label, hint, error, icon, ...input }: Omit<FieldProps, "type">) {
  return <FormField label={label} hint={hint} error={error}>{field => <WithIcon icon={icon}><PasswordInput {...input} {...field} /></WithIcon>}</FormField>;
}
