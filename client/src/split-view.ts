import type { LayoutNode, SplitDirection } from './types';
import { resizeSplit } from './layout';
import type { TerminalPane } from './terminal-pane';

export interface SplitViewOptions {
  getLayout: () => LayoutNode;
  getPane: (paneId: string) => TerminalPane;
  /** 更新布局比例（拖动过程中勿全量重渲染） */
  onResizeLayout: (layout: LayoutNode) => void;
  onResizeEnd?: () => void;
  /** split DOM 挂载完成（flex 尺寸可能下一帧才稳定） */
  onLayoutReady?: () => void;
}

export function renderSplitView(host: HTMLElement, options: SplitViewOptions): void {
  host.replaceChildren();
  renderNode(host, options.getLayout(), [], options);
  options.onLayoutReady?.();
}

/** 仅同步 split 的 flex 比例，不重建 DOM */
export function applySplitLayoutSizes(host: HTMLElement, layout: LayoutNode): void {
  applyNodeSizes(host, layout);
}

function applyNodeSizes(parent: HTMLElement, node: LayoutNode): void {
  if (node.type === 'pane') return;

  const splitEl = parent.classList.contains('split')
    ? parent
    : (parent.querySelector(':scope > .split') as HTMLElement | null);
  if (!splitEl) return;

  const childWraps = [...splitEl.querySelectorAll(':scope > .split-child')] as HTMLElement[];
  node.children.forEach((child, i) => {
    const wrap = childWraps[i];
    if (!wrap) return;
    wrap.style.flex = `${node.sizes[i]} 1 0%`;
    applyNodeSizes(wrap, child);
  });
}

function renderNode(
  parent: HTMLElement,
  node: LayoutNode,
  path: number[],
  options: SplitViewOptions,
): void {
  if (node.type === 'pane') {
    const pane = options.getPane(node.paneId);
    parent.appendChild(pane.container);
    pane.afterAttach();
    return;
  }

  const splitEl = document.createElement('div');
  splitEl.className = `split split-${node.direction}`;

  node.children.forEach((child, i) => {
    const childWrap = document.createElement('div');
    childWrap.className = 'split-child';
    childWrap.style.flex = `${node.sizes[i]} 1 0%`;
    renderNode(childWrap, child, [...path, i], options);
    splitEl.appendChild(childWrap);

    if (i < node.children.length - 1) {
      const divider = document.createElement('div');
      divider.className = `split-divider split-divider-${node.direction}`;
      setupDividerDrag(divider, path, i, node.direction, options);
      splitEl.appendChild(divider);
    }
  });

  parent.appendChild(splitEl);
}

function setupDividerDrag(
  divider: HTMLElement,
  path: number[],
  index: number,
  direction: SplitDirection,
  options: SplitViewOptions,
): void {
  divider.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    const splitEl = divider.parentElement;
    if (!splitEl) return;

    const children = [...splitEl.querySelectorAll(':scope > .split-child')] as HTMLElement[];
    const a = children[index];
    const b = children[index + 1];
    if (!a || !b) return;

    const start = direction === 'row' ? ev.clientX : ev.clientY;
    const total =
      direction === 'row'
        ? a.getBoundingClientRect().width + b.getBoundingClientRect().width
        : a.getBoundingClientRect().height + b.getBoundingClientRect().height;

    let last = start;

    const onMove = (moveEv: MouseEvent) => {
      const current = direction === 'row' ? moveEv.clientX : moveEv.clientY;
      const deltaPx = current - last;
      last = current;
      const deltaRatio = total > 0 ? deltaPx / total : 0;
      if (Math.abs(deltaRatio) < 0.0005) return;

      const next = resizeSplit(options.getLayout(), path, index, deltaRatio);
      options.onResizeLayout(next);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('dragging-split');
      options.onResizeEnd?.();
    };

    document.body.classList.add('dragging-split');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
