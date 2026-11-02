/** 仅在遮罩上按下并松开时关闭，避免框选拖出弹窗后误关 */
export function bindBackdropDismiss(overlay: HTMLElement, onClose: () => void): void {
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', (ev) => {
    downOnBackdrop = ev.target === overlay;
  });
  overlay.addEventListener('click', (ev) => {
    if (downOnBackdrop && ev.target === overlay) onClose();
    downOnBackdrop = false;
  });
}
