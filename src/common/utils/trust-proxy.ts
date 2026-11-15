import { isIP } from 'node:net';

/**
 * P3-BE03: parses TRUST_PROXY into an Express `trust proxy` value.
 *
 * Default (unset / "false"): no proxy is trusted, `request.ip` is the TCP
 * peer and X-Forwarded-For is ignored, so clients cannot choose their own
 * rate-limit key. Behind a reverse proxy set either the number of proxy hops
 * ("1") or the proxies' addresses / subnets / Express names
 * ("loopback", "10.0.0.0/8, 172.16.0.5"). "true" (trust every hop) is
 * refused: any client could then spoof its IP.
 */
export function parseTrustProxy(raw: string | undefined): false | number | string[] {
  const value = raw?.trim() ?? '';

  if (value === '' || value.toLowerCase() === 'false') return false;
  if (value.toLowerCase() === 'true') {
    throw new Error('TRUST_PROXY=true would trust spoofed X-Forwarded-For headers; use the hop count or proxy addresses');
  }
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops < 1 || hops > 10) throw new Error('TRUST_PROXY hop count must be between 1 and 10');
    return hops;
  }

  const entries = value.split(',').map((e) => e.trim()).filter(Boolean);
  for (const entry of entries) {
    if (['loopback', 'linklocal', 'uniquelocal'].includes(entry)) continue;
    const [address, prefix] = entry.split('/');
    const family = isIP(address);
    const prefixOk = prefix === undefined || (/^\d+$/.test(prefix) && Number(prefix) <= (family === 6 ? 128 : 32));
    if (!family || !prefixOk) {
      throw new Error('TRUST_PROXY entries must be IP addresses, CIDR subnets, or loopback/linklocal/uniquelocal');
    }
  }
  return entries;
}
