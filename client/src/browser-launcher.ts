/** 标签栏的「浏览器」按钮：直接在新页面打开无头浏览器（默认 1280×720，其它设置在页面里调） */
export class BrowserLauncher {
  private button: HTMLButtonElement;

  constructor(root: HTMLElement) {
    const actions = root.querySelector('.tab-bar-actions');
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'tab-action-btn browser-btn';
    this.button.title = '无头浏览器（在新页面打开）';
    this.button.setAttribute('aria-label', '无头浏览器');
    this.button.innerHTML =
      '<svg class="tab-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18"/><path d="M12 3a15 15 0 0 0 0 18"/></svg>';
    if (actions) {
      const anchor = actions.querySelector('.proxy-btn');
      if (anchor) actions.insertBefore(this.button, anchor);
      else actions.appendChild(this.button);
    } else {
      root.appendChild(this.button);
    }

    this.button.addEventListener('click', () => this.open());
  }

  private open(): void {
    const base = document.baseURI.endsWith('/') ? document.baseURI : `${document.baseURI}/`;
    const url = new URL('browser', base);
    url.searchParams.set('w', '1280');
    url.searchParams.set('h', '720');
    // 不用 noopener：新页面需要能自己关掉（window.close）
    window.open(url.toString(), '_blank');
  }
}
