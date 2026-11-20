export type EndpointTrust = 'auto' | 'private-network' | 'external';

/** Canonical HTTP base URL shared by connection validation and provider identity. */
export function modelEndpointURL(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint.endsWith('/') ? endpoint : endpoint + '/');
  } catch {
    throw new Error('Use a valid HTTP(S) endpoint without embedded credentials.');
  }
  const authority = endpoint.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i)?.[1];
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    authority?.includes('@') ||
    endpoint.includes('?') ||
    endpoint.includes('#')
  )
    throw new Error('Use an HTTP(S) endpoint without embedded credentials, query or fragment.');
  return url;
}

function ipv4(host: string): number[] | undefined {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return;
  const parts = host.split('.').map(Number);
  if (parts.every((part) => part >= 0 && part <= 255)) return parts;
}

/** Literal RFC1918/loopback IPv4 or IPv6 ULA/loopback; never resolves hostnames. */
export function endpointIsPrivate(url: URL): boolean {
  const host = url.hostname;
  const parts = ipv4(host);
  if (parts)
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  return host === '[::1]' || /^\[f[cd][\da-f]{2}:/i.test(host);
}

/** A LAN address becomes local only through the user's explicit trust assertion. */
export function endpointIsLocal(url: URL, trust: EndpointTrust = 'auto'): boolean {
  if (trust === 'external') return false;
  if (trust === 'private-network') {
    if (!endpointIsPrivate(url))
      throw new Error('Private-network trust requires a literal private or loopback IP address.');
    return true;
  }
  if (trust !== 'auto') throw new Error('Unknown endpoint trust setting.');
  return (
    url.hostname === 'localhost' || url.hostname === '[::1]' || ipv4(url.hostname)?.[0] === 127
  );
}
