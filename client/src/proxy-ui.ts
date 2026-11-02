import { ICONS } from './icons';
import { bindBackdropDismiss } from './modal-backdrop';
import { proxyApi, type ProxyEntry } from './proxy-api';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 目标地址展示：默认端口（http 80 / https 443）不显示 */
function formatTarget(
  scheme: string,
  host: string,
  port: number | string,
  openPath = '',
): string {
  const portText = String(port).trim();
  const isDefault =
    (scheme === 'http' && (portText === '80' || portText === '')) ||
    (scheme === 'https' && (portText === '443' || portText === ''));
  const portPart = isDefault ? '' : `:${portText}`;
  return `${scheme}://${host}${portPart}${openPath}`;
}

function targetText(entry: ProxyEntry): string {
  return formatTarget(entry.scheme, entry.host, entry.port, entry.openPath ?? '');
}

/** 应用可能挂在 /myterminal/ 之类的子路径下：按当前页面基准地址解析 */
function baseUrl(): string {
  return document.baseURI.endsWith('/') ? document.baseURI : `${document.baseURI}/`;
}

function proxyUrl(entry: ProxyEntry): string {
  const openPath = (entry.openPath ?? '').replace(/^\/+/, '');
  // 配了「打开路径」时直接打开该页面（不带尾斜杠，避免应用按目录拼 API 出错）
  return openPath
    ? new URL(`svc/${entry.slug}/${openPath}`, baseUrl()).toString()
    : new URL(`svc/${entry.slug}/`, baseUrl()).toString();
}

export class ProxyUi {
  private overlay: HTMLElement;
  private listEl: HTMLElement;
  private toastEl: HTMLElement;
  private formHost: HTMLElement;
  private entries: ProxyEntry[] = [];

  constructor(root: HTMLElement) {
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div class="sm-overlay modal-overlay proxy-overlay" hidden>
        <div class="modal sm-dialog proxy-dialog" role="dialog" aria-labelledby="proxy-title">
          <header class="modal-header sm-modal-header">
            <div class="modal-header-text">
              <h2 id="proxy-title">反代</h2>
            </div>
            <div class="sm-header-actions">
              <button type="button" class="btn-add-ssh proxy-create">+ 添加反代</button>
              <button type="button" class="modal-close proxy-close" aria-label="关闭">×</button>
            </div>
          </header>
          <div class="modal-body sm-body">
            <div class="sm-list proxy-list"></div>
          </div>
        </div>
      </div>
      <div class="sm-form-overlay modal-overlay proxy-form-overlay" hidden></div>
      <div class="sm-toast proxy-toast" hidden></div>
    `,
    );
    this.overlay = root.querySelector('.proxy-overlay')!;
    this.listEl = root.querySelector('.proxy-list')!;
    this.toastEl = root.querySelector('.proxy-toast')!;
    this.formHost = root.querySelector('.proxy-form-overlay')!;

    root.querySelector('.proxy-close')?.addEventListener('click', () => this.close());
    root.querySelector('.proxy-create')?.addEventListener('click', () => this.openForm(null));
    bindBackdropDismiss(this.overlay, () => this.close());
    bindBackdropDismiss(this.formHost, () => {
      this.formHost.hidden = true;
    });
  }

  open(): void {
    this.overlay.hidden = false;
    void this.refresh();
  }

  close(): void {
    this.overlay.hidden = true;
    this.formHost.hidden = true;
  }

  private showToast(message: string, error = false): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.toggle('sm-toast-error', error);
    this.toastEl.hidden = false;
    setTimeout(() => {
      this.toastEl.hidden = true;
    }, 3000);
  }

  private async refresh(): Promise<void> {
    try {
      this.entries = await proxyApi.list();
      this.renderList();
    } catch (e) {
      this.listEl.innerHTML = `<p class="sm-error">${escapeHtml(
        e instanceof Error ? e.message : '加载失败',
      )}</p>`;
    }
  }

  private renderList(): void {
    if (this.entries.length === 0) {
      this.listEl.innerHTML =
        '<p class="sm-empty">还没有反代。点击「添加反代」把本机某个端口映射成一个路径。</p>';
      return;
    }
    this.listEl.innerHTML = this.entries
      .map(
        (entry) => `
        <article class="sm-row proxy-row" data-id="${escapeHtml(entry.id)}">
          <button type="button" class="sm-target-grip proxy-drag sm-drag-handle" draggable="true" title="拖动排序" aria-label="拖动排序">${ICONS.grip}</button>
          <div class="sm-row-main">
            <div class="sm-row-title">
              <strong>${escapeHtml(entry.name)}</strong>
            </div>
            <div class="sm-row-desc proxy-row-desc">/svc/${escapeHtml(entry.slug)}${entry.openPath ? escapeHtml(entry.openPath) : ''} → ${escapeHtml(targetText(entry))}</div>
          </div>
          <div class="sm-row-actions proxy-row-actions">
            <button type="button" class="btn-secondary sm-btn proxy-open-btn proxy-open" title="新标签页打开" aria-label="打开">${ICONS.open}</button>
            <div class="proxy-actions-stack">
              <button type="button" class="btn-secondary sm-btn proxy-edit" title="编辑" aria-label="编辑">${ICONS.edit}</button>
              <button type="button" class="btn-secondary sm-btn sm-btn-danger proxy-del" title="删除" aria-label="删除">${ICONS.trash}</button>
            </div>
          </div>
        </article>`,
      )
      .join('');

    for (const row of this.listEl.querySelectorAll<HTMLElement>('.proxy-row')) {
      const entry = this.entries.find((e) => e.id === row.dataset.id);
      if (!entry) continue;
      row.querySelector('.proxy-open')?.addEventListener('click', () => {
        window.open(proxyUrl(entry), '_blank', 'noopener');
      });
      row.querySelector('.proxy-edit')?.addEventListener('click', () => this.openForm(entry));
      row.querySelector('.proxy-del')?.addEventListener('click', () => void this.remove(entry));
    }
    this.bindDragSort();
  }

  /** 拖动左侧把手调整顺序（和服务管理一致），松手后保存 */
  private bindDragSort(): void {
    let dragId: string | null = null;
    let dirty = false;
    const rowOf = (id: string): HTMLElement | null =>
      this.listEl.querySelector(`.proxy-row[data-id="${CSS.escape(id)}"]`);

    for (const handle of this.listEl.querySelectorAll('.proxy-drag')) {
      handle.addEventListener('dragstart', (ev) => {
        const drag = ev as DragEvent;
        const row = (drag.currentTarget as HTMLElement).closest('.proxy-row') as HTMLElement | null;
        dragId = row?.dataset.id ?? null;
        if (!dragId || !drag.dataTransfer) return;
        dirty = false;
        drag.dataTransfer.effectAllowed = 'move';
        drag.dataTransfer.setData('text/plain', dragId);
        row?.classList.add('sm-row-dragging');
      });
      const finish = (): void => {
        for (const row of this.listEl.querySelectorAll('.proxy-row')) {
          row.classList.remove('sm-row-dragging');
        }
        dragId = null;
        // 不依赖 dragover 是否触发：直接比较 DOM 顺序与已保存顺序
        const domOrder = this.domOrder();
        const savedOrder = this.entries.map((e) => e.id);
        if (domOrder.length > 0 && domOrder.join() !== savedOrder.join()) {
          void this.persistOrder();
        }
        dirty = false;
      };
      handle.addEventListener('dragend', finish);
      handle.addEventListener('drop', finish);
    }

    for (const row of this.listEl.querySelectorAll('.proxy-row')) {
      row.addEventListener('dragover', (ev) => {
        if (!dragId) return;
        const drag = ev as DragEvent;
        drag.preventDefault();
        if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'move';
        const target = drag.currentTarget as HTMLElement;
        const id = target.dataset.id;
        if (!id || id === dragId) return;
        const dragRow = rowOf(dragId);
        if (!dragRow) return;
        const rect = target.getBoundingClientRect();
        if (drag.clientY > rect.top + rect.height / 2) {
          if (dragRow === target.nextElementSibling) return;
          target.after(dragRow);
        } else {
          if (dragRow === target.previousElementSibling) return;
          target.before(dragRow);
        }
        dirty = true;
      });
      row.addEventListener('drop', (ev) => ev.preventDefault());
    }
  }

  private domOrder(): string[] {
    return [...this.listEl.querySelectorAll<HTMLElement>('.proxy-row')]
      .map((row) => row.dataset.id)
      .filter((id): id is string => !!id);
  }

  private async persistOrder(): Promise<void> {
    const order = this.domOrder();
    if (order.length === 0) return;
    try {
      this.entries = await proxyApi.reorder(order);
    } catch (e) {
      this.showToast(e instanceof Error ? e.message : '保存排序失败', true);
      await this.refresh();
    }
  }

  private async remove(entry: ProxyEntry): Promise<void> {
    if (!confirm(`确定删除反代「${entry.name}」（/svc/${entry.slug}）？`)) return;
    try {
      await proxyApi.remove(entry.id);
      this.showToast('已删除');
      await this.refresh();
    } catch (e) {
      this.showToast(e instanceof Error ? e.message : '删除失败', true);
    }
  }

  private openForm(entry: ProxyEntry | null): void {
    const isEdit = !!entry;
    const value = entry ?? {
      name: '',
      slug: '',
      host: '127.0.0.1',
      port: 0,
      scheme: 'http' as const,
      openPath: '',
    };
    this.formHost.innerHTML = `
      <div class="modal sm-form-dialog" role="dialog">
        <header class="modal-header">
          <div class="modal-header-text"><h2>${isEdit ? '编辑反代' : '添加反代'}</h2></div>
          <button type="button" class="modal-close proxy-form-close" aria-label="关闭">×</button>
        </header>
        <form class="sm-form modal-body">
          <div class="settings-row sm-form-row-head">
            <label class="settings-field settings-field-grow">
              <span>名称</span>
              <input name="name" maxlength="64" value="${escapeHtml(value.name)}" placeholder="例如：内部工具" />
            </label>
            <label class="settings-field settings-field-grow">
              <span>路径名 (*)</span>
              <input name="slug" required maxlength="63" value="${escapeHtml(value.slug)}" placeholder="例如：my-app" />
            </label>
          </div>
          <div class="settings-row sm-form-row-head">
            <label class="settings-field proxy-field-scheme">
              <span>协议</span>
              <select name="scheme">
                <option value="http" ${value.scheme === 'http' ? 'selected' : ''}>http</option>
                <option value="https" ${value.scheme === 'https' ? 'selected' : ''}>https</option>
              </select>
            </label>
            <label class="settings-field settings-field-grow">
              <span>目标 IP / 主机 (*)</span>
              <input name="host" required value="${escapeHtml(value.host)}" placeholder="127.0.0.1" />
            </label>
            <label class="settings-field settings-field-grow">
              <span>端口（留空自动）</span>
              <input name="port" inputmode="numeric" value="${value.port || ''}" placeholder="80" />
            </label>
            <label class="settings-field settings-field-grow">
              <span>打开路径（可选）</span>
              <input name="open_path" maxlength="120" value="${escapeHtml(value.openPath ?? '')}" placeholder="例如：/admin" />
            </label>
          </div>
          <p class="proxy-form-hint">访问地址：<code id="proxy-url-preview">/svc/&lt;路径名&gt;/</code></p>
          <p class="proxy-form-hint">反代地址：<code id="proxy-target-preview">http://127.0.0.1:80</code></p>
          <div class="modal-footer">
            <button type="button" class="btn-secondary proxy-form-cancel">取消</button>
            <button type="submit" class="btn-primary">${isEdit ? '保存' : '添加'}</button>
          </div>
        </form>
      </div>`;
    this.formHost.hidden = false;

    const form = this.formHost.querySelector<HTMLFormElement>('.sm-form')!;
    const slugInput = form.querySelector<HTMLInputElement>('input[name="slug"]')!;
    const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]')!;
    const preview = form.querySelector<HTMLElement>('#proxy-url-preview')!;
    // 访问地址预览：直接拼字符串，避免 new URL 把占位符里的 <> 编码成 %3C…
    let pathPrefix = '/';
    try {
      pathPrefix = decodeURIComponent(new URL(baseUrl()).pathname);
    } catch {
      pathPrefix = new URL(baseUrl()).pathname;
    }
    const openPathInput = form.querySelector<HTMLInputElement>('input[name="open_path"]');
    const hostInput = form.querySelector<HTMLInputElement>('input[name="host"]')!;
    const portInput = form.querySelector<HTMLInputElement>('input[name="port"]')!;
    const schemeSelect = form.querySelector<HTMLSelectElement>('select[name="scheme"]')!;
    const targetPreview = form.querySelector<HTMLElement>('#proxy-target-preview')!;
    /** 端口留空时按协议猜：http→80，https→443 */
    const effectivePort = (): string => {
      const raw = portInput.value.trim();
      if (raw) return raw;
      return schemeSelect.value === 'https' ? '443' : '80';
    };
    const syncPreview = (): void => {
      const slug = slugInput.value.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
      let openPath = (openPathInput?.value ?? '').trim();
      if (openPath && !openPath.startsWith('/')) openPath = `/${openPath}`;
      openPath = openPath.replace(/\/+$/, '');
      const base = `${pathPrefix}svc/${slug || '<路径名>'}`;
      preview.textContent = openPath ? `${base}${openPath}` : `${base}/`;
      const host = hostInput.value.trim() || '<目标主机>';
      targetPreview.textContent = formatTarget(
        schemeSelect.value,
        host,
        effectivePort(),
        openPath,
      );
    };
    openPathInput?.addEventListener('input', syncPreview);
    hostInput.addEventListener('input', syncPreview);
    portInput.addEventListener('input', syncPreview);
    schemeSelect.addEventListener('change', () => {
      portInput.placeholder = schemeSelect.value === 'https' ? '443' : '80';
      syncPreview();
    });
    portInput.placeholder = schemeSelect.value === 'https' ? '443' : '80';
    // 名称不再联动路径名（用户要求：名称改动不影响路径名）
    slugInput.addEventListener('input', () => {
      slugInput.dataset.touched = '1';
      // 路径名只允许单段：输入时就把 / 等非法字符过滤掉
      const cleaned = slugInput.value
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+/, '');
      if (cleaned !== slugInput.value) slugInput.value = cleaned;
      syncPreview();
    });
    syncPreview();

    this.formHost.querySelector('.proxy-form-close')?.addEventListener('click', () => {
      this.formHost.hidden = true;
    });
    this.formHost.querySelector('.proxy-form-cancel')?.addEventListener('click', () => {
      this.formHost.hidden = true;
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const payload = {
        name: String(data.get('name') ?? '').trim(),
        slug: String(data.get('slug') ?? '').trim().toLowerCase(),
        host: String(data.get('host') ?? '').trim(),
        // 端口留空 → 交给服务端按协议取默认值（http 80 / https 443）
        port: Number(String(data.get('port') ?? '').trim()) || 0,
        scheme: (String(data.get('scheme') ?? 'http') === 'https' ? 'https' : 'http') as
          | 'http'
          | 'https',
        open_path: String(data.get('open_path') ?? '').trim(),
      };
      void this.save(entry, payload);
    });
  }

  private async save(
    entry: ProxyEntry | null,
    payload: {
      name: string;
      slug: string;
      host: string;
      port: number;
      scheme: 'http' | 'https';
      open_path: string;
    },
  ): Promise<void> {
    try {
      if (entry) {
        await proxyApi.update(entry.id, payload);
        this.showToast('已保存');
      } else {
        await proxyApi.create(payload);
        this.showToast('已添加');
      }
      this.formHost.hidden = true;
      await this.refresh();
    } catch (e) {
      this.showToast(e instanceof Error ? e.message : '保存失败', true);
    }
  }
}
