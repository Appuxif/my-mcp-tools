/* Pure metadata projections for the per-tab HUD. No secrets or message bodies. */
(() => {
  function newest(items, property) {
    return items.reduce((best, current) =>
      !best || Number(current[property]) > Number(best[property]) ? current : best, null);
  }

  function latestInteraction(snapshot, agentId, direction) {
    const outbound = direction === 'out';
    const own = outbound ? 'source' : 'target';
    const other = outbound ? 'target' : 'source';
    const candidates = (snapshot.edges || []).filter(edge => edge[own] === agentId);
    const latest = newest(candidates, 'last_message_at');
    if (!latest) return null;

    const peers = new Map((snapshot.agents || []).map(agent => [agent.agent_id, agent.name]));
    const recent = (snapshot.recent || []).find(message =>
      message.sender_id === (outbound ? agentId : latest.source) &&
      message.recipient_id === (outbound ? latest.target : agentId) &&
      Math.abs(Number(message.created_at) - Number(latest.last_message_at)) < 0.001
    );
    return {
      peer: peers.get(latest[other]) || (outbound ? 'Unknown recipient' : 'Unknown sender'),
      time: Number(latest.last_message_at),
      status: recent?.status || null,
      pending: Number(latest.pending_count || 0),
    };
  }

  function summarize(snapshot, agentId) {
    const agent = (snapshot?.agents || []).find(a => a.agent_id === agentId);
    if (!agent) return null;
    const channel = newest((snapshot.channels || []).filter(c =>
      c.agent_id === agentId && Boolean(c.connected)), 'last_seen');
    const outgoing = (snapshot.edges || []).filter(e => e.source === agentId);
    const sent = outgoing.reduce((sum, e) => sum + Number(e.recent_count || 0), 0);
    const recent = (snapshot.recent || []).filter(message =>
      message.sender_id === agentId || message.recipient_id === agentId).slice(0, 4).map(message => ({
        direction: message.sender_id === agentId ? 'out' : 'in',
        peer: message.sender_id === agentId ? message.recipient_name : message.sender_name,
        time: Number(message.created_at),
        status: message.status,
      }));
    return {
      name: agent.name,
      role: agent.role || '',
      task: agent.current_task || '',
      taskStatus: agent.task_status || 'idle',
      online: !!agent.online,
      activeMcp: !!agent.active_mcp,
      lastMcp: Number(agent.last_mcp_activity) || null,
      lastPoll: Number(agent.last_poll_at) || null,
      pending: Number(agent.pending_messages || 0),
      sent24h: sent,
      sentCountIsLowerBound: !!snapshot.edgesTruncated || (snapshot.edges || []).length >= 100,
      lastOutbound: latestInteraction(snapshot, agentId, 'out'),
      lastInbound: latestInteraction(snapshot, agentId, 'in'),
      recent,
      adapter: channel ? {
        state: channel.state || 'unknown',
        lastSeen: Number(channel.last_seen) || null,
        lastWakeResult: channel.last_wake_result || '',
      } : null,
      lastWake: Number(agent.last_wake_at) || null,
      lastWakeResult: agent.last_wake_result || '',
      serverNow: Number(snapshot.server?.now) || null,
    };
  }

  function ago(timestamp, nowSeconds = Date.now() / 1000) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '—';
    const seconds = Math.max(0, Math.floor(nowSeconds - value));
    if (seconds < 5) return 'сейчас';
    if (seconds < 60) return seconds + ' сек';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' мин';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' ч';
    return Math.floor(seconds / 86400) + ' д';
  }

  const api = {summarize, ago, latestInteraction};
  globalThis.AgentNetworkStatus = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
