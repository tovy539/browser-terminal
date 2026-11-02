import { App } from './app';
import { runWithLoginGate } from './login-gate';
import './style.css';

function startApp(): void {
  const appEl = document.getElementById('app');
  if (!appEl) {
    throw new Error('#app not found');
  }
  new App(appEl);
}

void runWithLoginGate(startApp);
