import ipaddr from "ipaddr.js";

export function isRestrictedPeer(value: string) {
  if (ipaddr.isValid(value)) return true;
  try {
    const [address, prefix] = ipaddr.parseCIDR(value);
    return prefix > (address.kind() === "ipv6" && address.toString().startsWith("::ffff:") ? 96 : 0);
  } catch { return false; }
}

export function explicitPublicAdminAccess(mode: string, cidrs: readonly string[]) {
  return mode === "public" && cidrs.length === 1 && cidrs[0] === "internet";
}

export function exactHttpsOrigin(value: string) {
  const origin = new URL(value);
  return origin.protocol === "https:" && value === origin.origin;
}
