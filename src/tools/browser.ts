import { parseHTML } from 'linkedom';
import { fetchPublicHttp } from '../security/network.js';

export async function scrapeWebPage(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetchPublicHttp(url, { signal });
  const content = response.body.toString('utf8');
  if (response.contentType.includes('text/plain')) return content.trim() || 'No readable content found.';
  const { document } = parseHTML(content);
  document.querySelectorAll('script,style,noscript,svg').forEach((element) => element.remove());
  return document.body?.textContent?.replace(/\s+/g, ' ').trim() || 'No readable content found.';
}