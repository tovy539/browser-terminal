import { checkStoredAuth, fetchAuthConfig, loginWithPassword } from './auth';

export async function runWithLoginGate(startApp: () => void): Promise<void> {
  const config = await fetchAuthConfig();
  if (!config.required) {
    startApp();
    return;
  }

  if (await checkStoredAuth()) {
    startApp();
    return;
  }

  showLoginScreen(startApp);
}

function showLoginScreen(onSuccess: () => void): void {
  const root = document.body;
  root.replaceChildren();

  const wrap = document.createElement('div');
  wrap.className = 'login-gate';
  wrap.innerHTML = `
    <form class="login-card">
      <h1>Browser Terminal</h1>
      <p class="login-hint">请输入访问密码（成功后将记住在本机 Cookie，下次自动登录）</p>
      <input type="password" name="password" autocomplete="current-password" required />
      <p class="login-error" hidden></p>
      <button type="submit">进入</button>
    </form>
  `;

  const form = wrap.querySelector('form')!;
  const input = wrap.querySelector('input') as HTMLInputElement;
  const errEl = wrap.querySelector('.login-error') as HTMLElement;

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void (async () => {
      errEl.hidden = true;
      try {
        await loginWithPassword(input.value);
        root.replaceChildren();
        const appEl = document.createElement('div');
        appEl.id = 'app';
        root.appendChild(appEl);
        onSuccess();
      } catch (e) {
        errEl.textContent = e instanceof Error ? e.message : '登录失败';
        errEl.hidden = false;
        input.select();
      }
    })();
  });

  root.appendChild(wrap);
  input.focus();
}
