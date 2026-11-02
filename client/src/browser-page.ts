import './style.css';
import { BrowserPage } from './browser-view';
import { TerminalSocket } from './ws-client';

const params = new URLSearchParams(location.search);
const clamp = (value: number, min: number, max: number, fallback: number): number => {
  const n = Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, n));
};
const width = clamp(Number(params.get('w')), 320, 2560, 1280);
const height = clamp(Number(params.get('h')), 240, 1600, 720);

const root = document.getElementById('app');
if (root) {
  const socket = new TerminalSocket();
  new BrowserPage(root, socket, width, height);
}
