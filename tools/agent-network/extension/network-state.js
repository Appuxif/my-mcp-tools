/* Browser-network evidence for ChatGPT generation.
   Observes request metadata only. Never reads headers or bodies. */
(() => {
  const CHAT_PATHS = new Set([
    '/backend-api/f/conversation',
    '/backend-api/conversation',
  ]);

  function completionRequest(details) {
    if (!Number.isInteger(details.tabId) || details.tabId < 0 ||
        details.method !== 'POST') return false;
    try {
      const u = new URL(details.url);
      return u.protocol === 'https:' && u.hostname === 'chatgpt.com' &&
        CHAT_PATHS.has(u.pathname.replace(/\/$/, ''));
    } catch {
      return false;
    }
  }

  class TrafficTracker {
    constructor(options = {}) {
      this.active = new Map();
      this.endedAt = new Map();
      this.settleMs = options.settleMs ?? 1600;
      this.staleMs = options.staleMs ?? 10 * 60_000;
    }
    started(details, at = Date.now()) {
      if (!completionRequest(details)) return false;
      if (!this.active.has(details.tabId)) this.active.set(details.tabId, new Map());
      this.active.get(details.tabId).set(details.requestId, at);
      return true;
    }
    finished(details, at = Date.now()) {
      if (!completionRequest(details)) return false;
      const requests = this.active.get(details.tabId);
      if (requests) {
        requests.delete(details.requestId);
        if (!requests.size) this.active.delete(details.tabId);
      }
      this.endedAt.set(details.tabId, at);
      return true;
    }
    clear(tabId) {
      this.active.delete(tabId);
      this.endedAt.delete(tabId);
    }
    snapshot(tabId, at = Date.now()) {
      const requests = this.active.get(tabId);
      const activeCount = requests?.size ?? 0;
      if (activeCount) {
        const oldest = Math.min(...requests.values());
        return {
          phase: at - oldest > this.staleMs ? 'unknown' : 'running',
          activeRequests: activeCount,
        };
      }
      const elapsed = at - (this.endedAt.get(tabId) ?? -Infinity);
      return {
        phase: elapsed >= 0 && elapsed < this.settleMs ? 'settling' : 'idle',
        activeRequests: 0,
      };
    }
  }

  function combineState(domState, network) {
    // Network activity takes precedence over a missing or stale DOM spinner.
    if (network.phase === 'running' || network.phase === 'settling') {
      return { state: 'busy', reason: 'network ' + network.phase };
    }
    if (network.phase === 'unknown') {
      return { state: 'unknown', reason: 'stale network completion request' };
    }
    return {
      state: ['busy', 'idle', 'draft'].includes(domState) ? domState : 'unknown',
      reason: 'DOM with no active network completion request',
    };
  }

  const api = { completionRequest, TrafficTracker, combineState };
  globalThis.AgentNetworkTraffic = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
