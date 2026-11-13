import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

export const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as any;
for (const k of [
  'window',
  'document',
  'location',
  'history',
  'localStorage',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'HTMLSelectElement',
  'Node',
  'Event',
  'MouseEvent',
]) {
  g[k] = (dom.window as any)[k];
}
g.IS_REACT_ACT_ENVIRONMENT = true;

export const React = await import('react');
export const { act } = React;
const { createRoot } = await import('react-dom/client');
const { OverlayHost, Toast } = await import('../src/components/ui');

export async function mount(node: React.ReactNode) {
  const box = document.createElement('div');
  document.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => {
    root.render(React.createElement(React.Fragment, null, node, React.createElement(OverlayHost), React.createElement(Toast)));
  });
  return {
    box,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      box.remove();
    },
  };
}

export function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

export function setSelect(el: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
}

export function click(el: Element) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

export function buttonWithText(box: HTMLElement, text: string) {
  const btn = Array.from(box.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(text));
  assert.ok(btn, `missing button "${text}"`);
  return btn as HTMLButtonElement;
}
