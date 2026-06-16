/**
 * Minimal ambient typings for the `steam-user` library (v5.x), covering only
 * the surface this bot uses. The library ships no TypeScript types, so this
 * keeps `tsc --noEmit` and the editor happy without pulling in a heavy dep.
 *
 * See: node_modules/steam-user (DoctorMcKay/node-steam-user).
 */
declare module "steam-user" {
  interface SteamUserOptions {
    /** Directory where machine-auth / sentry data is persisted. */
    dataDirectory?: string | null;
    [key: string]: unknown;
  }

  interface LogOnDetails {
    accountName?: string;
    password?: string;
    rememberPassword?: boolean;
    [key: string]: unknown;
  }

  interface AuthSessionTicketResult {
    sessionTicket: Buffer;
  }

  /** Steam Guard callback: caller invokes it with the 2FA code. */
  type SteamGuardCallback = (code: string) => void;

  class SteamUser {
    constructor(options?: SteamUserOptions);

    logOn(details: LogOnDetails): void;
    logOff(): void;

    /**
     * steam-user@5: request an app auth session ticket. Calls back with
     * `{ sessionTicket: Buffer }` (or returns a Promise if no callback given).
     */
    createAuthSessionTicket(
      appid: number,
      callback: (err: Error | null, result: AuthSessionTicketResult) => void,
    ): void;

    // EventEmitter surface we rely on.
    on(event: "loggedOn", listener: (details: unknown) => void): this;
    on(
      event: "steamGuard",
      listener: (domain: string | null, callback: SteamGuardCallback, lastCodeWrong: boolean) => void,
    ): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  export = SteamUser;
}
