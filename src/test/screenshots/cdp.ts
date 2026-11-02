import * as fs from 'fs';

export interface Clip {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A minimal Chrome DevTools Protocol client for the workbench window, used to capture screenshots. */
export class Cdp {
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const waiter = this.pending.get(message.id);
      if (waiter) {
        this.pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(message.error.message));
        } else {
          waiter.resolve(message.result);
        }
      }
    });
  }

  static async connect(port: number): Promise<Cdp> {
    const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
    const page = targets.find((t) => t.type === 'page' && /workbench/.test(t.url));
    if (!page) {
      throw new Error(`No workbench page among ${targets.map((t) => t.url).join(', ')}`);
    }
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('Could not connect to the workbench')), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** Runs an expression in the workbench page and returns its value. */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return result.result?.value as T;
  }

  /** Lays the workbench out at a fixed size, whatever the window size, so screenshots are consistent. */
  async resize(width: number, height: number): Promise<void> {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }

  /** Drags the side bar's edge until the side bar is the given width. */
  async sideBarWidth(width: number): Promise<void> {
    const box = await this.evaluate<{ left: number; right: number; top: number; bottom: number }>(
      `(() => { const r = document.querySelector('.part.sidebar').getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })()`,
    );
    const y = Math.round((box.top + box.bottom) / 2);
    const from = Math.round(box.right) + 1;
    const to = Math.round(box.left + width);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from, y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 10; step++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(from + ((to - from) * step) / 10), y, button: 'left', buttons: 1 });
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to, y, button: 'left', clickCount: 1 });
    // Park the pointer on the status bar, so no hover or sash highlight shows in the screenshots.
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.left + width + 300), y: Math.round(box.bottom) + 10 });
  }

  /** The whole window as a PNG, scaled down by `scale`, for a frame of a recording. */
  async frame(width: number, height: number, scale: number): Promise<Buffer> {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height, scale } });
    return Buffer.from(data, 'base64');
  }

  /** Saves the window, or only the `clip` rectangle of it, as a PNG. */
  async capture(file: string, clip?: Clip): Promise<void> {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  }

  close(): void {
    this.socket.close();
  }
}
