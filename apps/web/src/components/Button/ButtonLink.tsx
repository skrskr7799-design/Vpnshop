import { Link, type LinkProps } from "react-router";
import { buttonClass, type ButtonVariant } from "./Button";

type ButtonLinkProps = LinkProps & { variant?: ButtonVariant; block?: boolean };

// Ссылка, выглядящая как кнопка (переход, а не действие)
export function ButtonLink({ variant = "primary", block = true, ...rest }: ButtonLinkProps) {
  return <Link className={buttonClass(variant, block)} {...rest} />;
}
