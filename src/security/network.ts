import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const blockedIpv4 = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4'];
const blockedIpv6 = ['::/128', '::1/128', '::ffff:0:0/96', '64:ff9b:1::/48', '100::/64', '2001:db8::/32', '2002::/16', 'fc00::/7', 'fe80::/10', 'ff00::/8'];

function ipv4Value(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) throw new Error('Invalid IPv4 address.');
  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

function ipv6Value(address: string) {
  let normalized = address.toLowerCase();
  if (normalized.includes('.')) {
    const lastColon = normalized.lastIndexOf(':');
    const ipv4 = ipv4Value(normalized.slice(lastColon + 1));
    normalized = `${normalized.slice(0, lastColon + 1)}${((ipv4 >> 16n) & 0xffffn).toString(16)}:${(ipv4 & 0xffffn).toString(16)}`;
  }
  const halves = normalized.split('::');
  if (halves.length > 2) throw new Error('Invalid IPv6 address.');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) throw new Error('Invalid IPv6 address.');
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) throw new Error('Invalid IPv6 address.');
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function inCidr(address: string, cidr: string, family: 4 | 6) {
  const [network, rawPrefix] = cidr.split('/');
  const prefix = Number(rawPrefix);
  const bits = family === 4 ? 32 : 128;
  const value = family === 4 ? ipv4Value(address) : ipv6Value(address);
  const networkValue = family === 4 ? ipv4Value(network) : ipv6Value(network);
  const shift = BigInt(bits - prefix);
  return (value >> shift) === (networkValue >> shift);
}

export function isPublicIpAddress(address: string) {
  const family = isIP(address);
  if (family === 0) return false;
  const blocked = family === 4 ? blockedIpv4 : blockedIpv6;
  return !blocked.some((cidr) => inCidr(address, cidr, family as 4 | 6));
}

export function validatePublicHttpUrl(input: string) {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only credential-free HTTP(S) URLs are allowed.');
  if ((url.protocol === 'http:' && url.port && url.port !== '80') || (url.protocol === 'https:' && url.port && url.port !== '443')) {
    throw new Error('Non-standard web ports are not allowed.');
  }
  if (url.hostname.endsWith('.') || url.hostname.toLowerCase() === 'localhost' || url.hostname.toLowerCase().endsWith('.localhost')) {
    throw new Error('Local hostnames are not allowed.');
  }
  return url;
}

export interface PublicFetchOptions {
  method?: 'GET' | 'POST';
  body?: string | Buffer | Uint8Array;
  signal?: AbortSignal;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  allowJson?: boolean;
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request?: (url: URL, address: string, family: number, options: { maxBytes: number; timeoutMs: number; signal?: AbortSignal; headers?: Record<string, string>; method: 'GET' | 'POST'; body?: string | Buffer | Uint8Array }) => Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>;
}

function requestPinned(url: URL, address: string, family: number, options: Required<Pick<PublicFetchOptions, 'maxBytes' | 'timeoutMs' | 'method'>> & Pick<PublicFetchOptions, 'signal' | 'headers' | 'body'>) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: options.method,
      headers: { Accept: 'text/html, text/plain, application/xhtml+xml, application/json', 'User-Agent': 'OpenArva/17.6', ...options.headers },
      lookup: ((_hostname: string, _options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => callback(null, address, family)) as never,
      servername: family === 6 || isIP(url.hostname) ? undefined : url.hostname,
      signal: options.signal,
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const contentLength = Number(response.headers['content-length'] || 0);
      if (contentLength > options.maxBytes) {
        response.destroy(new Error('Web response exceeds the configured byte limit.'));
        return;
      }
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          response.destroy(new Error('Web response exceeds the configured byte limit.'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    request.setTimeout(options.timeoutMs, () => request.destroy(new Error(`Web request timed out after ${options.timeoutMs}ms.`)));
    request.on('error', reject);
    request.end(options.body);
  });
}

export async function fetchPublicHttp(input: string, options: PublicFetchOptions = {}): Promise<{ url: string; status: number; contentType: string; body: Buffer }> {
  const forbiddenHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'proxy-authorization']);
  for (const name of Object.keys(options.headers || {})) {
    if (forbiddenHeaders.has(name.toLowerCase())) throw new Error(`Caller may not set the ${name} request header.`);
  }
  const maxBytes = Math.min(5 * 1024 * 1024, Math.max(1, options.maxBytes || 2 * 1024 * 1024));
  const timeoutMs = Math.min(30_000, Math.max(1, options.timeoutMs || 15_000));
  const maxRedirects = Math.min(5, Math.max(0, options.maxRedirects ?? 3));
  const method = options.method || 'GET';
  const resolveHost = options.resolveHost || (async (hostname) => {
    if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) }];
    return lookup(hostname, { all: true, verbatim: true });
  });

  let url = validatePublicHttpUrl(input);
  const originalHostname = url.hostname.toLowerCase();
  let requestHeaders = options.headers;
  for (let redirects = 0; ; redirects += 1) {
    if (options.signal?.aborted) throw new Error('Web request cancelled.');
    const addresses = await resolveHost(url.hostname);
    if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) {
      throw new Error(`Blocked non-public DNS result for ${url.hostname}.`);
    }
    const selected = addresses[0];
    const request = options.request || requestPinned;
    const response = await request(url, selected.address, selected.family, { maxBytes, timeoutMs, signal: options.signal, headers: requestHeaders, method, body: options.body });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      if (!location || redirects >= maxRedirects) throw new Error('Web redirect limit exceeded or redirect location missing.');
      url = validatePublicHttpUrl(new URL(location, url).toString());
      if (url.hostname.toLowerCase() !== originalHostname) {
        requestHeaders = Object.fromEntries(Object.entries(requestHeaders || {}).filter(([name]) => !['authorization', 'cookie', 'proxy-authorization'].includes(name.toLowerCase())));
      }
      continue;
    }
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (response.status < 200 || response.status >= 300) throw new Error(`Web request failed with HTTP ${response.status}.`);
    const allowedContent = options.allowJson
      ? /(text\/html|text\/plain|application\/xhtml\+xml|application\/(?:[\w.+-]+\+)?json)/
      : /(text\/html|text\/plain|application\/xhtml\+xml)/;
    if (!allowedContent.test(contentType)) throw new Error(`Unsupported web content type: ${contentType || 'unknown'}.`);
    return { url: url.toString(), status: response.status, contentType, body: response.body };
  }
}