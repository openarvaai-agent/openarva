interface RateWindow { startedAt: number; count: number; }

export class FixedWindowRateLimiter {
  private readonly clients = new Map<string, RateWindow>();

  constructor(private readonly limit = 60, private readonly windowMs = 60_000, private readonly maxClients = 10_000) {}

  allow(clientId: string, now = Date.now()) {
    if (!clientId || this.limit < 1 || this.windowMs < 1) return false;
    const current = this.clients.get(clientId);
    if (current && now - current.startedAt < this.windowMs) {
      if (current.count >= this.limit) return false;
      current.count += 1;
      return true;
    }
    if (this.clients.size >= this.maxClients) {
      for (const [key, window] of this.clients) if (now - window.startedAt >= this.windowMs) this.clients.delete(key);
      if (this.clients.size >= this.maxClients) return false;
    }
    this.clients.set(clientId, { startedAt: now, count: 1 });
    return true;
  }
}