import ipaddr from "ipaddr.js";

// Проверка адреса по списку сетей (CIDR). Пустой список = ограничения нет.
export function createIpGuard(cidrs: string[]): (ip: string) => boolean {
  if (cidrs.length === 0) return () => true;
  const ranges = cidrs.map((cidr) => {
    const parsed = ipaddr.parseCIDR(cidr); // бросит на мусоре: лучше упасть при старте
    return parsed;
  });
  return (ip) => {
    if (!ipaddr.isValid(ip)) return false;
    const addr = ipaddr.process(ip); // IPv4-mapped IPv6 приводится к IPv4
    return ranges.some(([range, bits]) => range.kind() === addr.kind() && addr.match(range, bits));
  };
}
