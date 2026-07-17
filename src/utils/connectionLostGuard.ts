/** Ensures error + close only trigger one connection-lost handling per IMAP session. */
export class ConnectionLostGuard {
  private handled = false;

  tryHandle(): boolean {
    if (this.handled) return false;
    this.handled = true;
    return true;
  }

  reset(): void {
    this.handled = false;
  }
}
