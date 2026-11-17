/* Geometry and age labels shared by dashboard and deterministic tests. */
(() => {
  function edgeAge(lastMessageAt, clock = Date.now() / 1000) {
    if (!Number.isFinite(lastMessageAt) || lastMessageAt <= 0) return null;
    const elapsed = Math.max(0, clock - lastMessageAt);
    if (elapsed > 600) return null;
    const age = Math.floor(elapsed);
    return age < 60 ? age + ' сек назад' : Math.floor(age / 60) + ' мин назад';
  }

  function edgeGeometry(a, b, reciprocal = false) {
    if (a.x === b.x && a.y === b.y) {
      // Self-message: draw a dedicated loop outside the node.
      const side = a.y < 125 ? 1 : -1;
      const edgeY = a.y + side * (a.height / 2 + 4);
      const curveY = edgeY + side * 74;
      return {
        path: `M ${a.x-22} ${edgeY} C ${a.x-93} ${curveY} ${a.x+93} ${curveY} ${a.x+22} ${edgeY}`,
        labelX: a.x, labelY: edgeY + side * 58,
      };
    }
    const dx = b.x - a.x, dy = b.y - a.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 3) return null;
    const ux = dx / distance, uy = dy / distance;
    const nx = -uy, ny = ux; // normal points left of this directed edge
    const border = node => Math.min(
      (node.width / 2 + 10) / Math.max(Math.abs(ux), .001),
      (node.height / 2 + 9) / Math.max(Math.abs(uy), .001)
    );
    const source = border(a), target = border(b);
    if (source + target + 10 >= distance) return null;
    // Reversing a->b flips the local normal, so both directions have their
    // own physical lane rather than overlapping on the centerline.
    const lane = reciprocal ? 11 : 0;
    const sx = a.x + ux * source + nx * lane;
    const sy = a.y + uy * source + ny * lane;
    const tx = b.x - ux * target + nx * lane;
    const ty = b.y - uy * target + ny * lane;
    const bend = reciprocal
      ? Math.min(90, Math.max(42, distance * .24))
      : Math.min(38, Math.max(12, distance * .095));
    const cx = (sx + tx) / 2 + nx * bend;
    const cy = (sy + ty) / 2 + ny * bend;
    return {
      path: `M ${sx} ${sy} Q ${cx} ${cy} ${tx} ${ty}`,
      labelX: (sx + 2 * cx + tx) / 4,
      labelY: (sy + 2 * cy + ty) / 4,
    };
  }

  function layoutGrid(count) {
    const columns = Math.min(7, Math.max(3, Math.ceil(Math.sqrt(count * 1.5))));
    const rows = Math.ceil(count / columns);
    const cellWidth = 330, cellHeight = 160;
    const width = Math.max(900, columns * cellWidth + 80);
    const height = Math.max(415, rows * cellHeight + 80);
    return {
      width, height, columns, rows,
      point(index) {
        return {
          x: 40 + (index % columns + 0.5) * cellWidth,
          y: 40 + (Math.floor(index / columns) + 0.5) * cellHeight
        };
      },
    };
  }

  // A multi-team agent appears once (union), and only links whose endpoints
  // are both visible remain in the map. Empty selection means no filter.
  function filterByTeams(data, selectedTeamIds) {
    const teams = new Set(selectedTeamIds || []);
    if (!teams.size) return data;
    const agents = data.agents.filter(agent =>
      (agent.teams || []).some(team => teams.has(team.team_id)));
    const visible = new Set(agents.map(agent => agent.agent_id));
    const edges = data.edges.filter(edge =>
      visible.has(edge.source) && visible.has(edge.target));
    return {...data, agents, edges};
  }

  const api = {edgeAge, edgeGeometry, layoutGrid, filterByTeams};
  globalThis.AgentNetworkGraph = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
