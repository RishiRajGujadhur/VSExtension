/**
 * Which feature's result is on screen, for the Actions view to highlight: the command whose report or chart was
 * shown last ("active"), and the one before it ("last run"). A report is credited to the command that ran just
 * before it was shown; a chart panel (Control Flow) sets itself while it is open.
 */
export class ActiveFeature {
  private current: string | undefined;
  private previous: string | undefined;
  private invoked: { command: string; at: number } | undefined;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  get active(): string | undefined {
    return this.current;
  }

  get last(): string | undefined {
    return this.previous;
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** A command started; a report shown in the next two minutes is its result. */
  noteInvoked(command: string): void {
    this.invoked = { command, at: this.now() };
  }

  /** The command started in the last few seconds, such as the one that found no file open. */
  recent(withinMs = 10_000): string | undefined {
    return this.invoked && this.now() - this.invoked.at < withinMs ? this.invoked.command : undefined;
  }

  /** A report was shown: the command that ran just before it becomes the active feature. */
  reportShown(): void {
    if (this.invoked && this.now() - this.invoked.at < 120_000) this.set(this.invoked.command);
  }

  set(command: string): void {
    // The same feature again: still a new result (its subject may have changed).
    if (command === this.current) {
      this.fire();
      return;
    }
    if (this.current) this.previous = this.current;
    this.current = command;
    this.fire();
  }

  /** The result of `command` was closed: it becomes the last run, and nothing is active. */
  closed(command: string): void {
    if (this.current !== command) return;
    this.previous = command;
    this.current = undefined;
    this.fire();
  }

  private fire(): void {
    for (const listener of this.listeners) listener();
  }
}

export const activeFeature = new ActiveFeature();
