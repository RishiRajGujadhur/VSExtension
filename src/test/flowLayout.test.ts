import * as assert from 'node:assert/strict';
import * as path from 'path';
import { test } from 'node:test';
import { buildCfg } from '../inspect/controlFlow';
import { layoutFlow } from '../structure/flowLayout';
import { functionAtOffset } from '../structure/util';
import { fixtures, offsetIn, virtualProject } from './helpers';

const file = path.join(fixtures, 'inspect/src/control.ts');

function layoutOf(marker: string) {
  const project = virtualProject('inspect', 'src/control.ts');
  const cfg = buildCfg(functionAtOffset(project.sourceFile(file), offsetIn(file, marker), project.program().getTypeChecker()));
  const layout = layoutFlow(
    cfg.nodes.map((n) => ({ id: n.id, width: 40 + Math.max(...n.lines.map((l) => l.length)) * 7, height: 20 + n.lines.length * 17 })),
    cfg.edges.map((e) => ({ from: e.from, to: e.to, back: e.kind === 'back' || e.kind === 'continue' })),
    cfg.start,
    cfg.end,
  );
  return { cfg, layout };
}

test('a flowchart runs top to bottom: every forward edge goes down, the end is last', () => {
  for (const marker of ['function getPer|mission', 'function tot|al', 'function gra|de', 'function fi|nd', 'function par|se', 'function ret|ry']) {
    const { cfg, layout } = layoutOf(marker);
    for (const edge of cfg.edges.filter((e) => e.kind !== 'back' && e.kind !== 'continue')) {
      assert.ok(layout.nodes.get(edge.to)!.row > layout.nodes.get(edge.from)!.row, `${marker}: ${cfg.nodes[edge.from].lines[0]} → ${cfg.nodes[edge.to].lines[0]}`);
    }
    const end = layout.nodes.get(cfg.end)!;
    assert.ok([...layout.nodes.values()].every((p) => p.row <= end.row), marker);
    assert.equal(layout.nodes.get(cfg.start)!.row, 0);
  }
});

test('boxes in the same row never overlap', () => {
  for (const marker of ['function getPer|mission', 'function gra|de', 'function par|se']) {
    const { layout } = layoutOf(marker);
    const placed = [...layout.nodes.values()];
    for (const a of placed) {
      for (const b of placed) {
        if (a !== b && a.row === b.row) assert.ok(a.x + a.width <= b.x || b.x + b.width <= a.x, marker);
      }
    }
    assert.ok(placed.every((p) => p.x >= 0 && p.x + p.width <= layout.width), marker);
  }
});

test('loop edges go back up along the right side', () => {
  const { cfg, layout } = layoutOf('function tot|al');
  const back = cfg.edges.map((e, i) => ({ e, route: layout.routes[i] })).filter(({ e }) => e.kind === 'back' || e.kind === 'continue');
  assert.equal(back.length, 2);
  for (const { e, route } of back) {
    assert.equal(route.points.length, 4);
    const lane = route.points[1].x;
    // The lane is right of both ends, and the edge ends at the loop header.
    assert.ok(lane >= layout.nodes.get(e.from)!.x + layout.nodes.get(e.from)!.width);
    assert.ok(lane >= layout.nodes.get(e.to)!.x + layout.nodes.get(e.to)!.width);
    assert.equal(cfg.nodes[e.to].kind, 'loop');
  }
});

test('the two branches of a decision leave from separate points', () => {
  const { cfg, layout } = layoutOf('function getPer|mission');
  const decision = cfg.nodes.find((n) => n.lines[0] === '!user.active')!;
  const starts = cfg.edges.map((e, i) => ({ e, r: layout.routes[i] })).filter(({ e }) => e.from === decision.id).map(({ r }) => r.points[0].x);
  assert.equal(new Set(starts).size, 2);
});

test('the Control Flow chart has every node placed, source locations and the paths', async () => {
  const { controlFlowChart, nodeAtOffset } = await import('../inspect/controlFlowChart');
  const project = virtualProject('inspect', 'src/control.ts');
  const chart = controlFlowChart(project, file, offsetIn(file, 'function getPer|mission'));
  assert.equal(chart.name, 'getPermission');
  assert.equal(chart.paths.length, 5);
  assert.deepEqual(chart.paths[0].steps.map((s) => s.text), ['not user.active']);
  assert.equal(chart.paths[0].ending, "returns 'blocked'");
  const decision = chart.nodes.find((n) => n.lines[0] === '!user.active')!;
  assert.equal(decision.location?.line, offsetLine('if (!user.active)'));
  // The editor's cursor on `sensitive` in `if (sensitive)` finds that decision, not the switch around it.
  const at = nodeAtOffset(chart, project.sourceFile(file), offsetIn(file, 'if (sens|itive)'));
  assert.equal(chart.nodes[at!].lines[0], 'sensitive');
});

test('the control flow copies as a Mermaid flowchart, with a picked path drawn thick', async () => {
  const { controlFlowChart, chartMermaid } = await import('../inspect/controlFlowChart');
  const chart = controlFlowChart(virtualProject('inspect', 'src/control.ts'), file, offsetIn(file, 'function tot|al'));
  const text = chartMermaid(chart, { nodes: chart.paths[0].nodes, edges: chart.paths[0].edges });
  const lines = text.split('\n');
  assert.equal(lines[0], 'flowchart TD');
  assert.ok(lines.includes('  n0(("total"))'), text);
  assert.ok(lines.includes('  n3{{"for (const item of items)"}}'), text);
  assert.ok(lines.some((l) => / -- each item --> /.test(l)));
  // Loop edges are dotted.
  assert.ok(lines.some((l) => /-\.->/.test(l)));
  assert.ok(lines.some((l) => l.startsWith('  class ') && l.endsWith(' onPath')));
  assert.ok(lines.some((l) => l.startsWith('  linkStyle ')));
});

function offsetLine(marker: string): number {
  const text = require('fs').readFileSync(file, 'utf8') as string;
  return text.slice(0, text.indexOf(marker)).split('\n').length - 1;
}
