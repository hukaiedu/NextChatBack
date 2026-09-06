export class ProviderPageLock {
  private locked = false;
  private waiters: Array<() => void> = [];
  private _activeCount = 0;
  private _maxConcurrency = 0;

  get activeCount(): number {
    return this._activeCount;
  }

  get maxConcurrency(): number {
    return this._maxConcurrency;
  }

  resetStats(): void {
    this._maxConcurrency = this._activeCount;
  }

  tryAcquire(): boolean {
    if (this.locked) return false;
    this.locked = true;
    this._activeCount++;
    if (this._activeCount > this._maxConcurrency) {
      this._maxConcurrency = this._activeCount;
    }
    return true;
  }

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      this._activeCount++;
      if (this._activeCount > this._maxConcurrency) {
        this._maxConcurrency = this._activeCount;
      }
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this._activeCount++;
        if (this._activeCount > this._maxConcurrency) {
          this._maxConcurrency = this._activeCount;
        }
        resolve();
      });
    });
  }

  release(): void {
    if (!this.locked) return;
    this._activeCount--;
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }
}
