import type { ButtonHTMLAttributes } from "react";
import { Spinner } from "../Spinner/Spinner";
import "./Button.css";

export type ButtonVariant = "primary" | "secondary";

export const buttonClass = (variant: ButtonVariant = "primary", block = false): string =>
  `btn btn--${variant}${block ? " btn--block" : ""}`;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  block?: boolean;
  loading?: boolean;
};

export function Button({ variant = "primary", block = true, loading = false, disabled, children, ...rest }: ButtonProps) {
  return (
    <button
      className={buttonClass(variant, block)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}
