import { Button as Control } from "@vpn/ui";
import type { ComponentProps } from "react";
export { buttonClass } from "@vpn/ui";

export type ButtonVariant = "primary" | "secondary";
export function Button({ block = true, ...props }: ComponentProps<typeof Control>) {
  return <Control {...props} block={block} />;
}
