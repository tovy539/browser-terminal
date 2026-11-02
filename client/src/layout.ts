import type { LayoutNode, PaneConnection, PaneNode, SplitDirection } from './types';
import { randomId } from './uuid';

export function createPane(paneId?: string, connection?: PaneConnection): PaneNode {
  return {
    type: 'pane',
    paneId: paneId ?? randomId(),
    connection: connection ?? { kind: 'local' },
  };
}

export function createDefaultLayout(): LayoutNode {
  return createPane();
}

export function findPane(layout: LayoutNode, paneId: string): PaneNode | null {
  if (layout.type === 'pane') {
    return layout.paneId === paneId ? layout : null;
  }
  for (const child of layout.children) {
    const found = findPane(child, paneId);
    if (found) return found;
  }
  return null;
}

export function collectPaneIds(layout: LayoutNode): string[] {
  if (layout.type === 'pane') return [layout.paneId];
  return layout.children.flatMap(collectPaneIds);
}

function replaceNode(
  layout: LayoutNode,
  targetPaneId: string,
  replacement: LayoutNode,
): LayoutNode | null {
  if (layout.type === 'pane') {
    return layout.paneId === targetPaneId ? replacement : layout;
  }

  const children = layout.children
    .map((child) => replaceNode(child, targetPaneId, replacement))
    .filter((c): c is LayoutNode => c !== null);

  if (children.length === 0) return null;
  if (children.length === 1) return children[0];

  const sizes = normalizeSizes(
    layout.children.map((_, i) => {
      const orig = layout.children[i];
      const next = children[i];
      if (next && orig) return layout.sizes[i] ?? 1 / layout.children.length;
      return 0;
    }).filter((s) => s > 0),
  );

  return { type: 'split', direction: layout.direction, sizes, children };
}

function normalizeSizes(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  if (sum <= 0) return sizes.map(() => 1 / sizes.length);
  return sizes.map((s) => s / sum);
}

function walkLayout(
  layout: LayoutNode,
  visit: (node: LayoutNode) => LayoutNode | 'skip-children',
): LayoutNode {
  const result = visit(layout);
  if (result === 'skip-children') {
    throw new Error('invalid visit result at root');
  }
  if (result !== layout) {
    return result;
  }
  if (layout.type === 'split') {
    return {
      ...layout,
      children: layout.children.map((c) => walkLayout(c, visit)),
    };
  }
  return layout;
}

export type SplitSide = 'before' | 'after';

/** before=左/上，after=右/下 */
export function splitPane(
  layout: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  side: SplitSide = 'after',
): { layout: LayoutNode; newPaneId: string; applied: boolean } {
  let applied = false;
  let newPaneId = paneId;

  const nextLayout = walkLayout(layout, (node) => {
    if (node.type === 'pane' && node.paneId === paneId) {
      applied = true;
      const newPane = createPane(undefined, node.connection);
      newPaneId = newPane.paneId;
      const pair = side === 'after' ? [node, newPane] : [newPane, node];
      return {
        type: 'split',
        direction,
        sizes: [0.5, 0.5],
        children: pair,
      };
    }
    return node;
  });

  return {
    layout: nextLayout,
    newPaneId,
    applied,
  };
}

export function closePane(layout: LayoutNode, paneId: string): LayoutNode | null {
  if (layout.type === 'pane') {
    return layout.paneId === paneId ? null : layout;
  }

  const results: LayoutNode[] = [];
  const keptSizes: number[] = [];

  layout.children.forEach((child, i) => {
    const next = closePane(child, paneId);
    if (next) {
      results.push(next);
      keptSizes.push(layout.sizes[i] ?? 1 / layout.children.length);
    }
  });

  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  return {
    type: 'split',
    direction: layout.direction,
    sizes: normalizeSizes(keptSizes),
    children: results,
  };
}

export function firstPaneId(layout: LayoutNode): string {
  if (layout.type === 'pane') return layout.paneId;
  return firstPaneId(layout.children[0]);
}

export function resizeSplit(
  layout: LayoutNode,
  splitPath: number[],
  index: number,
  deltaRatio: number,
): LayoutNode {
  if (splitPath.length === 0) {
    if (layout.type !== 'split') return layout;
    const sizes = [...layout.sizes];
    const i = index;
    const j = index + 1;
    if (j >= sizes.length) return layout;

    const min = 0.08;
    let a = sizes[i] + deltaRatio;
    let b = sizes[j] - deltaRatio;
    if (a < min) {
      b -= min - a;
      a = min;
    }
    if (b < min) {
      a -= min - b;
      b = min;
    }
    sizes[i] = a;
    sizes[j] = b;
    return { ...layout, sizes: normalizeSizes(sizes) };
  }

  if (layout.type === 'pane') return layout;
  const [head, ...rest] = splitPath;
  const children = layout.children.map((child, i) =>
    i === head ? resizeSplit(child, rest, index, deltaRatio) : child,
  );
  return { ...layout, children };
}

/** 布局结构 + 比例签名，用于避免无变化时全量重渲染终端 DOM */
export function layoutSignature(layout: LayoutNode): string {
  if (layout.type === 'pane') {
    return `p:${layout.paneId}`;
  }
  const sizes = layout.sizes.map((s) => s.toFixed(5)).join(',');
  const children = layout.children.map(layoutSignature).join('|');
  return `${layout.direction}[${sizes}](${children})`;
}
