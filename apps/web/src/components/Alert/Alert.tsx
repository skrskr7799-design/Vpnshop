import type { ReactNode } from "react";
import "./Alert.css";

type AlertProps = { variant?: "error" | "success" | "info"; children: ReactNode };

export function Alert({ variant = "info", children }: AlertProps) {
  return (
    <div className={`alert alert--${variant}`} role={variant === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
