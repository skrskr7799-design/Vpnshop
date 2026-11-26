import { useProductConfig } from "../config";

export function ProductLinks({ kind }: { kind: "legal" | "support" }) {
  const { data } = useProductConfig();
  const product = data?.product;
  if (!product) return null;
  const links = kind === "legal"
    ? [[product.legalTermsUrl, "Условия обслуживания"], [product.legalPrivacyUrl, "Конфиденциальность"], [product.legalRefundUrl, "Возвраты"]]
    : [[product.supportUrl, "Связаться с поддержкой"], [product.supportEmail ? "mailto:" + encodeURIComponent(product.supportEmail) : null, product.supportEmail]];
  const available = links.filter(([href]) => href);
  if (!available.length) return null;
  return <ul className="mzt-product-links" aria-label={kind === "legal" ? "Правовая информация" : "Контакты поддержки"}>
    {available.map(([href, label]) => <li key={href}><a href={href!} rel="noreferrer">{label}</a></li>)}
  </ul>;
}
