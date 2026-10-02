import { describe, expect, it } from 'vitest';
import { fetchPublicHttp, isPublicIpAddress, validatePublicHttpUrl } from './network.js';

describe('public network policy', () => {
  it('blocks private, loopback, link-local, multicast, and mapped addresses', () => {
    for (const address of ['127.0.0.1', '10.2.3.4', '172.20.0.1', '192.168.1.1', '169.254.10.2', '100.64.0.1', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1']) {
      expect(isPublicIpAddress(address), address).toBe(false);
    }
    expect(isPublicIpAddress('8.8.8.8')).toBe(true);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('rejects credentials and nonstandard ports in URLs', () => {
    expect(() => validatePublicHttpUrl('http://user:pass@example.com/')).toThrow('credential-free');
    expect(() => validatePublicHttpUrl('http://example.com:8080/')).toThrow('Non-standard');
  });

  it('rejects a DNS response containing any private address before making a request', async () => {
    let requestCount = 0;
    await expect(fetchPublicHttp('https://public.example/', {
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
      request: async () => { requestCount += 1; throw new Error('must not issue request'); },
    })).rejects.toThrow('Blocked non-public DNS result');
    expect(requestCount).toBe(0);
  });

  it('re-resolves and blocks a redirect that changes to a private target', async () => {
    let lookups = 0;
    let requests = 0;
    await expect(fetchPublicHttp('https://public.example/start', {
      resolveHost: async () => {
        lookups += 1;
        return lookups === 1 ? [{ address: '8.8.8.8', family: 4 }] : [{ address: '10.0.0.4', family: 4 }];
      },
      request: async () => {
        requests += 1;
        return { status: 302, headers: { location: 'https://redirect.example/private' }, body: Buffer.alloc(0) };
      },
    })).rejects.toThrow('Blocked non-public DNS result');
    expect(lookups).toBe(2);
    expect(requests).toBe(1);
  });

  it('strips authorization when a public redirect changes host', async () => {
    const sentHeaders: Array<Record<string, string> | undefined> = [];
    let requestCount = 0;
    const response = await fetchPublicHttp('https://github.example/api/private', {
      allowJson: true,
      headers: { Authorization: 'Bearer test-token' },
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (_url, _address, _family, options) => {
        sentHeaders.push(options.headers);
        requestCount += 1;
        return requestCount === 1
          ? { status: 302, headers: { location: 'https://cdn.example/result.json' }, body: Buffer.alloc(0) }
          : { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{}') };
      },
    });

    expect(response.status).toBe(200);
    expect(sentHeaders[0]?.Authorization).toBe('Bearer test-token');
    expect(sentHeaders[1]?.Authorization).toBeUndefined();
  });

  it('rejects caller-controlled Host headers', async () => {
    await expect(fetchPublicHttp('https://public.example/', { headers: { Host: '127.0.0.1' } })).rejects.toThrow('may not set the Host');
  });

  it('pins and bounds authenticated POST requests without following redirects', async () => {
    let sentOptions: { method: 'GET' | 'POST'; body?: string | Buffer | Uint8Array; headers?: Record<string, string> } | undefined;
    const response = await fetchPublicHttp('https://api.example/send', {
      method: 'POST',
      body: '{"message":"hello"}',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' },
      allowJson: true,
      maxRedirects: 0,
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async (_url, _address, _family, options) => {
        sentOptions = options;
        return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') };
      },
    });

    expect(response.status).toBe(200);
    expect(sentOptions?.method).toBe('POST');
    expect(sentOptions?.body).toBe('{"message":"hello"}');
    expect(sentOptions?.headers?.Authorization).toBe('Bearer test-secret');
  });

  it('accepts vendor JSON media types used by GitHub APIs', async () => {
    const response = await fetchPublicHttp('https://api.github.com/repos/example/repo', {
      allowJson: true,
      maxRedirects: 0,
      resolveHost: async () => [{ address: '8.8.8.8', family: 4 }],
      request: async () => ({
        status: 200,
        headers: { 'content-type': 'application/vnd.github+json' },
        body: Buffer.from('{"full_name":"example/repo"}'),
      }),
    });

    expect(response.contentType).toContain('application/vnd.github+json');
    expect(JSON.parse(response.body.toString('utf8')).full_name).toBe('example/repo');
  });
});