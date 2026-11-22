import ipaddr from "ipaddr.js";

export function isRestrictedPeer(value: string) {
  if (ipaddr.isValid(value)) return true;
  try {
    const [address, prefix] = ipaddr.parseCIDR(value);
    return prefix > (address.kind() === "ipv6" && address.toString().startsWith("::ffff:") ? 96 : 0);
  } catch { return false; }
}

export function exactHttpsOrigin(value: string) {
  const origin = new URL(value);
  return origin.protocol === "https:" && value === origin.origin;
}
