import { ICONS } from './icons';
import { bindBackdropDismiss } from './modal-backdrop';
import {
  smApi,
  type Service,
  type ServiceInput,
} from './service-manager-api';
import { fetchSshProfiles, type SshProfilePublic } from './ssh-api';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 列表展示：保留描述中的换行 */
function formatDescriptionHtml(s: string): string {
  return escapeHtml(s).replace(/\r\n|\n|\r/g, '<br>');
}

function formatUptime(sec: number | null): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—';
  const total = Math.floor(sec);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function stateLabel(state: string): string {
  if (state === 'failed') return '失败';
  if (state === 'starting') return '启动中';
  return '已停止';
}

function smRowStateClass(state: string): string {
  if (state === 'running') return 'sm-row-running';
  if (state === 'failed') return 'sm-row-failed';
  return '';
}

function statusBadgeHtml(state: string): string {
  if (state === 'running') return '';
  const badgeClass =
    state === 'failed' ? 'sm-badge-fail' : 'sm-badge-stop';
  return `<span class="sm-badge ${badgeClass}">${stateLabel(state)}</span>`;
}

/** 拖动手柄上显示：本机 或 目标 IP 末段后两位 */
function targetGripSuffix2(host: string): string {
  const h = host.trim();
  const v4tail = h.match(/\.(\d{1,3})$/);
  if (v4tail) {
    return v4tail[1].slice(-2).padStart(2, '0');
  }
  const digits = h.replace(/\D/g, '');
  if (digits.length >= 2) return digits.slice(-2);
  return h.slice(-2) || '??';
}

function targetGripHtml(
  sshProfileId: string | null,
  profiles: Map<string, SshProfilePublic>,
): string {
  if (!sshProfileId) {
    return `<button type="button" class="sm-target-grip sm-drag-handle sm-target-grip-local" draggable="true" title="本机 · 拖动排序" aria-label="本机，拖动排序"><span class="sm-target-grip-text">本机</span></button>`;
  }
  const p = profiles.get(sshProfileId);
  if (!p) {
    const label = '??';
    return `<button type="button" class="sm-target-grip sm-drag-handle sm-target-grip-remote" draggable="true" title="远程 · 拖动排序" aria-label="远程，拖动排序"><span class="sm-target-grip-text">${label}</span></button>`;
  }
  const suffix = targetGripSuffix2(p.host);
  const title = `${escapeHtml(p.name)} · ${escapeHtml(p.host)} · 拖动排序`;
  return `<button type="button" class="sm-target-grip sm-drag-handle sm-target-grip-remote" draggable="true" title="${title}" aria-label="${escapeHtml(p.name)} ${suffix}，拖动排序"><span class="sm-target-grip-text">${escapeHtml(suffix)}</span></button>`;
}

/** 页签目标：本机 + 设置里的 SSH 设备（外加服务引用了但配置已不存在的设备） */
interface ServiceTarget {
  id: string;
  name: string;
  host?: string;
  sshProfileId: string | null;
}

function serviceTargetId(svc: Service): string {
  return svc.ssh_profile_id ?? 'local';
}

function envToText(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i <= 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1);
  }
  return out;
}

const emptyForm: ServiceInput = {
  name: '',
  description: '',
  command: '',
  working_dir: '',
  env: {},
  keep_running: false,
  ssh_profile_id: null,
};

function listStructureFingerprint(services: Service[], busy: string | null): string {
  const rows = services.map((s, index) => ({
    index,
    name: s.name,
    description: s.description,
    keep_running: s.keep_running,
    ssh_profile_id: s.ssh_profile_id,
    state: s.status.state,
    pid: s.status.pid,
    last_error: s.status.last_error,
    busy: busy === s.name,
  }));
  return JSON.stringify(rows);
}

function listStatusFingerprint(services: Service[], busy: string | null): string {
  const rows = services.map((s, index) => ({
    index,
    name: s.name,
    state: s.status.state,
    pid: s.status.pid,
    uptimeSec:
      s.status.uptime_seconds != null && Number.isFinite(s.status.uptime_seconds)
        ? Math.floor(s.status.uptime_seconds)
        : null,
    busy: busy === s.name,
  }));
  return JSON.stringify(rows);
}

export class ServiceManagerUi {
  private overlay: HTMLElement;
  private listEl: HTMLElement;
  private toastEl: HTMLElement;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private logTimer: ReturnType<typeof setInterval> | null = null;
  private busy: string | null = null;
  private logName: string | null = null;
  private lastStructureFingerprint = '';
  private lastStatusFingerprint = '';
  private lastTabsFingerprint = '';
  private listDragging = false;
  private sshProfileById = new Map<string, SshProfilePublic>();
  /** 当前页签：'local' 或 SSH 配置 id */
  private activeTarget: string = 'local';
  /** 全量服务（排序合并用；列表只显示当前页签的） */
  private allServices: Service[] = [];
  private tabsEl!: HTMLElement;

  constructor(root: HTMLElement) {
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div class="sm-overlay modal-overlay" hidden>
        <div class="modal sm-dialog" role="dialog" aria-labelledby="sm-title">
          <header class="modal-header sm-modal-header">
            <div class="modal-header-text">
              <h2 id="sm-title">服务管理</h2>
            </div>
            <div class="sm-header-actions">
              <button type="button" class="btn-add-ssh sm-create">+ 新建服务</button>
              <button type="button" class="modal-close sm-close" aria-label="关闭">${ICONS.close}</button>
            </div>
          </header>
          <div class="modal-body sm-body">
            <nav class="sm-tabs" role="tablist" aria-label="目标设备"></nav>
            <div class="sm-list"></div>
          </div>
        </div>
      </div>
      <div class="sm-form-overlay modal-overlay" hidden></div>
      <div class="sm-log-overlay modal-overlay" hidden></div>
      <div class="sm-toast" hidden></div>
    `,
    );

    this.overlay = root.querySelector('.sm-overlay')!;
    this.listEl = root.querySelector('.sm-list')!;
    this.tabsEl = root.querySelector('.sm-tabs')!;
    try {
      const saved = localStorage.getItem('sm-active-target');
      if (saved) this.activeTarget = saved;
    } catch {
      /* 隐私模式等 */
    }
    this.toastEl = root.querySelector('.sm-toast')!;

    root.querySelector('.sm-close')?.addEventListener('click', () => this.close());
    bindBackdropDismiss(this.overlay, () => this.close());
    root.querySelector('.sm-create')?.addEventListener('click', () => this.openForm('create'));
    const formHost = root.querySelector('.sm-form-overlay')!;
    bindBackdropDismiss(formHost, () => {
      formHost.hidden = true;
    });

    const logHost = root.querySelector('.sm-log-overlay')!;
    bindBackdropDismiss(logHost, () => this.closeLogs());
  }

  open(): void {
    this.overlay.hidden = false;
    this.lastStructureFingerprint = '';
    this.lastStatusFingerprint = '';
    void this.refresh(true);
    this.refreshTimer = setInterval(() => void this.refresh(false), 5000);
  }

  close(): void {
    this.overlay.hidden = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    this.lastStructureFingerprint = '';
    this.lastStatusFingerprint = '';
    this.closeLogs();
  }

  private showToast(msg: string, error = false): void {
    this.toastEl.textContent = msg;
    this.toastEl.classList.toggle('sm-toast-error', error);
    this.toastEl.hidden = false;
    setTimeout(() => {
      this.toastEl.hidden = true;
    }, 3500);
  }

  private selectionInServiceList(): boolean {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const anchor = sel.anchorNode;
    if (!anchor) return false;
    const el =
      anchor.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor.parentElement;
    return !!el?.closest('.sm-list');
  }

  /** 当前页签对应的目标设备（本机为空串） */
  private activeTargetValue(): string {
    return this.activeTarget === 'local' ? '' : this.activeTarget;
  }

  private listHasRows(): boolean {
    return this.listEl.querySelector('.sm-row') != null;
  }

  private patchListStatus(services: Service[]): void {
    const byName = new Map(services.map((s) => [s.name, s]));
    for (const row of this.listEl.querySelectorAll('.sm-row')) {
      const name = (row as HTMLElement).dataset.name;
      if (!name) continue;
      const s = byName.get(name);
      if (!s) continue;
      const st = s.status.state;
      const busy = this.busy === s.name;
      const pidLine = `PID ${s.status.pid ?? '—'} · ${formatUptime(s.status.uptime_seconds)}`;

      row.classList.remove('sm-row-running', 'sm-row-failed');
      const rowState = smRowStateClass(st);
      if (rowState) row.classList.add(rowState);

      let badge = row.querySelector('.sm-badge');
      if (st === 'running') {
        badge?.remove();
      } else {
        const badgeClass = st === 'failed' ? 'sm-badge-fail' : 'sm-badge-stop';
        if (!badge) {
          const title = row.querySelector('.sm-row-title');
          badge = document.createElement('span');
          badge.className = `sm-badge ${badgeClass}`;
          title?.insertBefore(badge, title.querySelector('.sm-row-pid'));
        }
        badge.textContent = stateLabel(st);
        badge.className = `sm-badge ${badgeClass}`;
      }
      const pidEl = row.querySelector('.sm-row-pid');
      if (pidEl) pidEl.textContent = pidLine;

      const main = row.querySelector('.sm-row-main');
      let errEl = row.querySelector('.sm-row-err');
      if (s.status.last_error) {
        if (!errEl && main) {
          errEl = document.createElement('div');
          errEl.className = 'sm-row-err';
          main.appendChild(errEl);
        }
        if (errEl) errEl.textContent = s.status.last_error;
      } else if (errEl) {
        errEl.remove();
      }

      const startBtn = row.querySelector('.sm-start') as HTMLButtonElement | null;
      const stopBtn = row.querySelector('.sm-stop') as HTMLButtonElement | null;
      const restartBtn = row.querySelector('.sm-restart') as HTMLButtonElement | null;
      const logBtn = row.querySelector('.sm-log') as HTMLButtonElement | null;
      const editBtn = row.querySelector('.sm-edit') as HTMLButtonElement | null;
      const delBtn = row.querySelector('.sm-del') as HTMLButtonElement | null;
      if (startBtn) startBtn.disabled = busy || st === 'running';
      if (stopBtn) stopBtn.disabled = busy || st !== 'running';
      if (restartBtn) restartBtn.disabled = busy;
      if (logBtn) logBtn.disabled = busy;
      if (editBtn) editBtn.disabled = busy;
      if (delBtn) delBtn.disabled = busy;
    }
  }

  private buildTargets(list: Service[]): ServiceTarget[] {
    const targets: ServiceTarget[] = [
      { id: 'local', name: '本机', sshProfileId: null },
    ];
    for (const p of this.sshProfileById.values()) {
      targets.push({ id: p.id, name: p.name, host: p.host, sshProfileId: p.id });
    }
    // 服务引用了已删除的 SSH 配置时，别让它们在界面上消失
    for (const svc of list) {
      const id = serviceTargetId(svc);
      if (id !== 'local' && !targets.some((t) => t.id === id)) {
        targets.push({
          id,
          name: `未知设备 ${id.slice(-6)}`,
          sshProfileId: id,
        });
      }
    }
    return targets;
  }

  private renderTabs(targets: ServiceTarget[], list: Service[]): void {
    const byTarget = new Map<string, { total: number; running: number }>();
    for (const svc of list) {
      const id = serviceTargetId(svc);
      const entry = byTarget.get(id) ?? { total: 0, running: 0 };
      entry.total += 1;
      if (svc.status.state === 'running') entry.running += 1;
      byTarget.set(id, entry);
    }
    this.tabsEl.innerHTML = targets
      .map((t) => {
        const c = byTarget.get(t.id) ?? { total: 0, running: 0 };
        const active = t.id === this.activeTarget;
        const countHtml =
          c.total > 0
            ? `<span class="sm-tab-count${c.running > 0 ? ' sm-tab-count-running' : ''}">${c.running > 0 ? `${c.running}/` : ''}${c.total}</span>`
            : '';
        const title = t.host ? `${t.name} · ${t.host}` : t.name;
        return `<button type="button" role="tab" class="sm-tab${active ? ' sm-tab-active' : ''}" data-target="${escapeHtml(t.id)}" aria-selected="${active ? 'true' : 'false'}" title="${escapeHtml(title)}"><span class="sm-tab-name">${escapeHtml(t.name)}</span>${countHtml}</button>`;
      })
      .join('');
    for (const btn of this.tabsEl.querySelectorAll<HTMLElement>('.sm-tab')) {
      btn.addEventListener('click', () => this.selectTarget(btn.dataset.target ?? 'local'));
    }
  }

  private selectTarget(id: string): void {
    if (id === this.activeTarget) return;
    this.activeTarget = id;
    try {
      localStorage.setItem('sm-active-target', id);
    } catch {
      /* ignore */
    }
    this.lastStructureFingerprint = '';
    this.lastStatusFingerprint = '';
    this.lastTabsFingerprint = '';
    void this.refresh(true);
  }

  private async refresh(force = false): Promise<void> {
    try {
      const profiles = await fetchSshProfiles();
      this.sshProfileById = new Map(profiles.map((p) => [p.id, p]));
      const list = await smApi.list();
      this.allServices = list;

      const targets = this.buildTargets(list);
      if (!targets.some((t) => t.id === this.activeTarget)) {
        this.activeTarget = 'local';
      }
      const tabsFp = JSON.stringify(
        targets.map((t) => {
          const rows = list.filter((s) => serviceTargetId(s) === t.id);
          return [t.id, t.name, t.host ?? '', rows.length, rows.filter((r) => r.status.state === 'running').length];
        }).concat([[this.activeTarget]]),
      );
      if (force || tabsFp !== this.lastTabsFingerprint) {
        this.lastTabsFingerprint = tabsFp;
        this.renderTabs(targets, list);
      }

      const visible = list.filter((s) => serviceTargetId(s) === this.activeTarget);
      const structFp = `${this.activeTarget}|${listStructureFingerprint(visible, this.busy)}`;
      const statusFp = `${this.activeTarget}|${listStatusFingerprint(visible, this.busy)}`;

      if (
        !force &&
        structFp === this.lastStructureFingerprint &&
        statusFp === this.lastStatusFingerprint
      ) {
        return;
      }

      if (
        !force &&
        structFp === this.lastStructureFingerprint &&
        this.listHasRows()
      ) {
        this.lastStatusFingerprint = statusFp;
        this.patchListStatus(visible);
        return;
      }

      if (!force && (this.selectionInServiceList() || this.listDragging)) {
        return;
      }

      this.lastStructureFingerprint = structFp;
      this.lastStatusFingerprint = statusFp;
      this.renderList(visible);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '加载失败';
      const errHtml = `<p class="sm-error">${escapeHtml(msg)}</p>`;
      if (this.listEl.innerHTML !== errHtml) {
        this.lastStructureFingerprint = '';
        this.lastStatusFingerprint = '';
        this.listEl.innerHTML = errHtml;
      }
    }
  }

  private renderList(services: Service[]): void {
    if (services.length === 0) {
      const who = this.activeTarget === 'local' ? '本机' : '该设备';
      this.listEl.innerHTML = `<p class="sm-empty">${who}还没有服务。点击「新建服务」添加要守护的命令。</p>`;
      return;
    }

    const rows = services
      .map((s) => {
        const st = s.status.state;
        const flags = s.keep_running ? '<span class="sm-flag">保持运行</span>' : '';
        const err = s.status.last_error
          ? `<div class="sm-row-err">${escapeHtml(s.status.last_error)}</div>`
          : '';
        const busy = this.busy === s.name;
        const pidLine = `PID ${s.status.pid ?? '—'} · ${formatUptime(s.status.uptime_seconds)}`;
        return `
        <article class="sm-row ${smRowStateClass(st)}" data-name="${escapeHtml(s.name)}">
          ${targetGripHtml(s.ssh_profile_id, this.sshProfileById)}
          <div class="sm-row-main">
            <div class="sm-row-title">
              <strong>${escapeHtml(s.name)}</strong>
              ${statusBadgeHtml(st)}
              <span class="sm-row-pid">${pidLine}</span>
            </div>
            ${s.description ? `<div class="sm-row-desc">${formatDescriptionHtml(s.description)}</div>` : ''}
            ${flags ? `<div class="sm-row-flags">${flags}</div>` : ''}
            ${err}
          </div>
          <div class="sm-row-actions">
            <div class="sm-row-actions-row">
              <button type="button" class="btn-secondary sm-btn sm-start" title="启动" aria-label="启动" ${busy || st === 'running' ? 'disabled' : ''}>${ICONS.play}</button>
              <button type="button" class="btn-secondary sm-btn sm-stop" title="停止" aria-label="停止" ${busy || st !== 'running' ? 'disabled' : ''}>${ICONS.stop}</button>
              <button type="button" class="btn-secondary sm-btn sm-restart" title="重启" aria-label="重启" ${busy ? 'disabled' : ''}>${ICONS.restart}</button>
            </div>
            <div class="sm-row-actions-row">
              <button type="button" class="btn-secondary sm-btn sm-log" title="日志" aria-label="日志" ${busy ? 'disabled' : ''}>${ICONS.logs}</button>
              <button type="button" class="btn-secondary sm-btn sm-edit" title="编辑" aria-label="编辑" ${busy ? 'disabled' : ''}>${ICONS.edit}</button>
              <button type="button" class="btn-secondary sm-btn sm-btn-danger sm-del" title="删除" aria-label="删除" ${busy ? 'disabled' : ''}>${ICONS.trash}</button>
            </div>
          </div>
        </article>`;
      })
      .join('');

    this.listEl.innerHTML = rows;

    for (const row of this.listEl.querySelectorAll('.sm-row')) {
      const name = (row as HTMLElement).dataset.name!;
      row.querySelector('.sm-log')?.addEventListener('click', () => this.openLogs(name));
      row.querySelector('.sm-start')?.addEventListener('click', () => void this.run(name, 'start'));
      row.querySelector('.sm-stop')?.addEventListener('click', () => void this.run(name, 'stop'));
      row.querySelector('.sm-restart')?.addEventListener('click', () => void this.run(name, 'restart'));
      row.querySelector('.sm-edit')?.addEventListener('click', () => {
        const svc = services.find((x) => x.name === name);
        if (svc) this.openForm('edit', svc);
      });
      row.querySelector('.sm-del')?.addEventListener('click', () => void this.run(name, 'delete'));
    }

    this.bindListDragSort();
  }

  private listOrderFromDom(): string[] {
    return [...this.listEl.querySelectorAll('.sm-row')]
      .map((row) => (row as HTMLElement).dataset.name)
      .filter((n): n is string => !!n);
  }

  private bindListDragSort(): void {
    let dragName: string | null = null;
    let orderDirty = false;

    const findRow = (name: string): HTMLElement | null =>
      this.listEl.querySelector(`.sm-row[data-name="${CSS.escape(name)}"]`);

    for (const handle of this.listEl.querySelectorAll('.sm-drag-handle')) {
      handle.addEventListener('dragstart', (ev) => {
        const row = (ev.currentTarget as HTMLElement).closest('.sm-row') as HTMLElement | null;
        dragName = row?.dataset.name ?? null;
        if (!dragName || !ev.dataTransfer) return;
        this.listDragging = true;
        orderDirty = false;
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', dragName);
        row?.classList.add('sm-row-dragging');
      });

      handle.addEventListener('dragend', () => {
        this.listDragging = false;
        for (const row of this.listEl.querySelectorAll('.sm-row')) {
          row.classList.remove('sm-row-dragging');
        }
        const name = dragName;
        dragName = null;
        if (!orderDirty || !name) return;
        orderDirty = false;
        void this.persistListOrder();
      });
    }

    for (const row of this.listEl.querySelectorAll('.sm-row')) {
      row.addEventListener('dragover', (ev) => {
        if (!dragName) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        const target = ev.currentTarget as HTMLElement;
        const name = target.dataset.name;
        if (!name || name === dragName) return;
        const dragRow = findRow(dragName);
        if (!dragRow) return;
        const rect = target.getBoundingClientRect();
        const after = ev.clientY > rect.top + rect.height / 2;
        if (after) {
          if (dragRow === target.nextElementSibling) return;
          target.after(dragRow);
        } else {
          if (dragRow === target.previousElementSibling) return;
          target.before(dragRow);
        }
        orderDirty = true;
      });

      row.addEventListener('drop', (ev) => {
        ev.preventDefault();
      });
    }
  }

  private async persistListOrder(): Promise<void> {
    const target = this.activeTargetValue();
    const keyOf = (name: string): string => {
      const found = this.allServices.find(
        (s) => s.name === name && (s.ssh_profile_id ?? '') === target,
      );
      return found?.key ?? `${target}\u0000${name}`;
    };
    const visible = this.listOrderFromDom().map(keyOf);
    // 服务端要求提交"全部服务"的顺序：把当前页签的槽位按新顺序填回，其它目标原样保留
    const visibleSet = new Set(visible);
    const allKeys = this.allServices.map((s) => s.key ?? `${s.ssh_profile_id ?? ''}\u0000${s.name}`);
    const merged: string[] = [];
    let vi = 0;
    for (const key of allKeys) {
      if (visibleSet.has(key)) {
        merged.push(visible[vi++] ?? key);
      } else {
        merged.push(key);
      }
    }
    const order = merged.length === allKeys.length ? merged : visible;
    try {
      await smApi.reorder(order);
      this.lastStructureFingerprint = '';
      await this.refresh(true);
    } catch (e) {
      this.showToast(e instanceof Error ? e.message : '保存排序失败', true);
      await this.refresh(true);
    }
  }

  private async run(name: string, action: 'start' | 'stop' | 'restart' | 'delete'): Promise<void> {
    if (action === 'delete' && !confirm(`确定删除服务「${name}」？`)) return;
    this.busy = name;
    await this.refresh(true);
    try {
      const target = this.activeTargetValue();
      if (action === 'delete') {
        await smApi.remove(name, target);
        this.showToast('已删除');
      } else {
        const r = await smApi[action](name, target);
        this.showToast(r.message, !r.ok);
      }
      await this.refresh(true);
    } catch (e) {
      this.showToast(e instanceof Error ? e.message : '操作失败', true);
    } finally {
      this.busy = null;
      await this.refresh(true);
    }
  }

  private openForm(mode: 'create' | 'edit', svc?: Service): void {
    void this.renderForm(mode, svc);
  }

  private async renderForm(mode: 'create' | 'edit', svc?: Service): Promise<void> {
    const host = this.overlay.parentElement!.querySelector('.sm-form-overlay')! as HTMLElement;
    const profiles = await fetchSshProfiles();
    this.sshProfileById = new Map(profiles.map((p) => [p.id, p]));
    const form = {
      ...(svc
        ? {
            name: svc.name,
            description: svc.description,
            command: svc.command,
            working_dir: svc.working_dir,
            env: svc.env,
            keep_running: svc.keep_running,
            ssh_profile_id: svc.ssh_profile_id,
          }
        : {
            ...emptyForm,
            // 在某个设备的页签下点"新建"，默认就建到那台设备上
            ssh_profile_id: this.activeTarget === 'local' ? null : this.activeTarget,
          }),
    };
    const editName = mode === 'edit' ? svc!.name : null;
    const envText = envToText(form.env);
    const selectedTarget = form.ssh_profile_id ?? 'local';
    const profileOptions = profiles
      .map((p) => {
        const cred = p.hasStoredCredential ? '' : '（未保存凭据）';
        return `<option value="${escapeHtml(p.id)}" ${selectedTarget === p.id ? 'selected' : ''}>${escapeHtml(p.name)}${escapeHtml(cred)}</option>`;
      })
      .join('');

    host.innerHTML = `
      <div class="modal sm-form-dialog" role="dialog">
        <header class="modal-header">
          <div class="modal-header-text">
            <h2>${mode === 'create' ? '新建服务' : `编辑 · ${escapeHtml(editName!)}`}</h2>
          </div>
          <button type="button" class="modal-close sm-form-close" aria-label="关闭">×</button>
        </header>
        <form class="sm-form modal-body">
          <div class="settings-row sm-form-row-head">
            <label class="settings-field settings-field-grow">
              <span>名称 (*)</span>
              <input name="name" required maxlength="64" value="${escapeHtml(form.name)}" placeholder="支持中文" />
            </label>
            <label class="settings-field settings-field-grow">
              <span>目标设备 (*)</span>
              <select name="target_host" class="sm-target-host" required>
                <option value="local" ${selectedTarget === 'local' ? 'selected' : ''}>本机</option>
                ${profileOptions}
              </select>
            </label>
            <label class="settings-field settings-field-grow">
              <span>工作目录</span>
              <input name="working_dir" value="${escapeHtml(form.working_dir)}" placeholder="可选" />
            </label>
          </div>
          <label class="settings-field">
            <span>启动命令 (*)</span>
            <input name="command" type="text" required value="${escapeHtml(form.command)}" />
          </label>
          <div class="settings-row sm-form-row-text">
            <label class="settings-field settings-field-grow">
              <span>描述</span>
              <textarea name="description" rows="5" wrap="off" placeholder="可选">${escapeHtml(form.description)}</textarea>
            </label>
            <label class="settings-field settings-field-grow">
              <span>环境变量</span>
              <textarea name="env" rows="5" wrap="off" placeholder="可选，每行 KEY=VALUE">${escapeHtml(envText)}</textarea>
            </label>
          </div>
          <label class="settings-field sm-check">
            <input type="checkbox" name="keep_running" ${form.keep_running ? 'checked' : ''} />
            保持运行
          </label>
          <div class="modal-footer">
            <button type="button" class="btn-secondary sm-form-cancel">取消</button>
            <button type="submit" class="btn-primary">保存</button>
          </div>
        </form>
      </div>`;

    host.hidden = false;
    const close = () => {
      host.hidden = true;
    };
    host.querySelector('.sm-form-close')?.addEventListener('click', close);
    host.querySelector('.sm-form-cancel')?.addEventListener('click', close);
    host.querySelector('.sm-form-dialog')?.addEventListener('click', (ev) => ev.stopPropagation());

    host.querySelector('.sm-form')?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const fd = new FormData(ev.target as HTMLFormElement);
      const target = String(fd.get('target_host') || 'local');
      const payload: ServiceInput = {
        name: String(fd.get('name') || '').trim(),
        description: String(fd.get('description') || ''),
        command: String(fd.get('command') || '').trim(),
        working_dir: String(fd.get('working_dir') || ''),
        env: textToEnv(String(fd.get('env') || '')),
        keep_running: fd.get('keep_running') === 'on',
        ssh_profile_id: target === 'local' ? null : target,
      };
      void (async () => {
        try {
          if (mode === 'create') {
            await smApi.create(payload);
            this.showToast('服务已创建');
          } else if (editName) {
            const body: Partial<ServiceInput> & { name?: string } = {
              description: payload.description,
              command: payload.command,
              working_dir: payload.working_dir,
              env: payload.env,
              keep_running: payload.keep_running,
              ssh_profile_id: payload.ssh_profile_id,
            };
            if (payload.name !== editName) body.name = payload.name;
            await smApi.update(editName, svc?.ssh_profile_id ?? '', body);
            this.showToast('服务已更新');
          }
          close();
          await this.refresh(true);
        } catch (e) {
          this.showToast(e instanceof Error ? e.message : '保存失败', true);
        }
      })();
    });
  }

  private openLogs(name: string): void {
    this.logName = name;
    const host = this.overlay.parentElement!.querySelector('.sm-log-overlay')! as HTMLElement;
    host.innerHTML = `
      <div class="modal sm-log-dialog" role="dialog">
        <header class="modal-header">
          <div class="modal-header-text"><h2>运行日志 · ${escapeHtml(name)}</h2></div>
          <button type="button" class="modal-close sm-log-close" aria-label="关闭">×</button>
        </header>
        <div class="modal-body sm-log-body">
          <p class="sm-log-meta">自动刷新（2s）</p>
          <pre class="sm-log-view"></pre>
        </div>
      </div>`;
    host.hidden = false;
    const pre = host.querySelector('.sm-log-view')!;
    const meta = host.querySelector('.sm-log-meta')!;

    const load = async (force = false) => {
      try {
        const r = await smApi.logs(name, this.activeTargetValue());
        const text = r.content || '暂无日志';
        const metaText = r.truncated
          ? '仅显示最近 500 行 · 自动刷新（2s）'
          : '自动刷新（2s）';
        if (meta.textContent !== metaText) meta.textContent = metaText;
        if (!force && pre.textContent === text) return;

        const stickBottom =
          pre.scrollHeight - pre.scrollTop <= pre.clientHeight + 8;
        pre.textContent = text;
        if (stickBottom) pre.scrollTop = pre.scrollHeight;
      } catch (e) {
        const err = e instanceof Error ? e.message : '加载失败';
        if (force || pre.textContent !== err) pre.textContent = err;
      }
    };

    void load(true);
    this.logTimer = setInterval(() => void load(false), 2000);

    host.querySelector('.sm-log-close')?.addEventListener('click', () => this.closeLogs());
    host.querySelector('.sm-log-dialog')?.addEventListener('click', (ev) => ev.stopPropagation());
  }

  private closeLogs(): void {
    if (this.logTimer) clearInterval(this.logTimer);
    this.logTimer = null;
    this.logName = null;
    const host = this.overlay.parentElement?.querySelector('.sm-log-overlay') as HTMLElement | null;
    if (host) host.hidden = true;
  }
}
