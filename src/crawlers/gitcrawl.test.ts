import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../security/network.js', () => ({
  fetchPublicHttp: vi.fn(),
}));

vi.mock('./store.js', () => ({
  indexCrawlRecords: vi.fn((records: unknown[]) => records.length),
}));

import { fetchPublicHttp } from '../security/network.js';
import { crawlGitHub } from './gitcrawl.js';

beforeEach(() => {
  vi.mocked(fetchPublicHttp).mockReset();
});

describe('GitHub crawler network boundary', () => {
  it('uses pinned HTTPS, no-redirect requests for repository data and token credentials', async () => {
    vi.mocked(fetchPublicHttp).mockImplementation(async (input) => {
      const url = String(input);
      const body = url.endsWith('/issues?state=all&per_page=100') || url.endsWith('/pulls?state=all&per_page=100') || url.endsWith('/commits?per_page=100')
        ? []
        : { id: 1, name: 'agent', full_name: 'acme/agent', html_url: 'https://github.com/acme/agent' };
      return {
        url,
        status: 200,
        contentType: 'application/vnd.github+json',
        body: Buffer.from(JSON.stringify(body)),
      };
    });

    const result = await crawlGitHub({ repository: 'acme/agent', token: 'github-test-token' });

    expect(result).toMatchObject({ repository: 'acme/agent', fetched: 1, indexed: 1 });
    expect(fetchPublicHttp).toHaveBeenCalledTimes(4);
    for (const [, options] of vi.mocked(fetchPublicHttp).mock.calls) {
      expect(options).toMatchObject({ allowJson: true, maxRedirects: 0 });
      expect(options?.headers?.Authorization).toBe('Bearer github-test-token');
    }
  });
});
