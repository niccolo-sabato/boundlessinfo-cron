/**
 * Step 1 of the auth chain: obtain a Steam auth session ticket for Boundless
 * (app id 324510), as a hex string.
 *
 * Faithfully ported from Boundlexx's `docker/bin/steam-auth-ticket` (MIT,
 * Angellus) which uses the `steam-user` library (DoctorMcKay). Key behaviours
 * preserved:
 *   - logOn with rememberPassword:true so the machine-auth/sentry persists
 *     under `dataDirectory` (our STEAM_SENTRY_DIR). After the first interactive
 *     Steam Guard step, later logins are headless.
 *   - the session ticket is requested a few seconds AFTER 'loggedOn' to let the
 *     client settle (the original waits 5s); the ticket buffer is returned as a
 *     lowercase hex string.
 *
 * steam-user@5.x note: the method is `createAuthSessionTicket(appid, cb)` and the
 * callback resolves with `{sessionTicket: Buffer}` (verified against 5.3.0
 * components/appauth.js). Internally it needs the account to OWN the app and a
 * game-connect (GC) token, both of which arrive shortly after `loggedOn`, hence
 * the settle delay + a dedicated ticket timeout.
 *
 * Steam Guard: modern accounts with the mobile authenticator can be confirmed
 * TWO ways for the same login: tap "Approve" in the Steam app (device
 * confirmation, polled automatically by steam-session) OR type the 5-character
 * code from the app's Steam Guard screen. We support both, with a generous
 * window for the interactive step so the ticket generation never gets starved.
 */

import SteamUser from "steam-user";
import { config, STEAM_APP_ID, STEAM_SENTRY_DIR } from "./config.ts";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

/**
 * Where we persist the steam-session refresh token. Accounts with the mobile
 * authenticator need a fresh 2FA code for every CREDENTIAL login, so for headless
 * re-logins (spike/scan/cron) we log on with this long-lived refresh token instead
 * (no code needed). It is written after the one-time interactive bootstrap.
 */
const REFRESH_TOKEN_FILE = resolve(STEAM_SENTRY_DIR, "refresh-token.json");

function readSavedRefreshToken(account: string): string | null {
  try {
    if (!existsSync(REFRESH_TOKEN_FILE)) return null;
    const saved = JSON.parse(readFileSync(REFRESH_TOKEN_FILE, "utf8")) as {
      account?: string;
      refreshToken?: string;
    };
    return saved.account === account && saved.refreshToken ? saved.refreshToken : null;
  } catch {
    return null;
  }
}

function saveRefreshToken(account: string, refreshToken: string): void {
  try {
    writeFileSync(REFRESH_TOKEN_FILE, JSON.stringify({ account, refreshToken }), "utf8");
  } catch {
    /* ignore */
  }
}

export interface SteamTicketOptions {
  /**
   * When true (the `bootstrap` command), prompt on the terminal for the Steam
   * Guard code if Steam asks for one (you can also just approve in the app).
   * When false (cron/headless), a Steam Guard prompt is fatal: it means the
   * sentry is missing/expired and a human must re-run `npm run bootstrap`.
   */
  interactive?: boolean;
  /** Seconds to settle after login before requesting the ticket. Default 5. */
  settleSeconds?: number;
}

/**
 * Log in to Steam and return a fresh auth session ticket as a hex string.
 *
 * Resolves once the ticket is in hand, then logs off cleanly. Rejects on any
 * login error, or on a Steam Guard prompt when `interactive` is false.
 */
export function getSteamTicket(opts: SteamTicketOptions = {}): Promise<string> {
  const interactive = opts.interactive ?? false;
  const settleSeconds = opts.settleSeconds ?? 5;
  const debug = process.env.STEAM_DEBUG === "1";

  // Generous budget for the human step (approve in app or type the code); the
  // ticket step gets its own, shorter budget once we are logged on.
  const loginTimeoutMs = interactive ? 180_000 : 60_000;
  const ticketTimeoutMs = 45_000;

  // Ensure the sentry directory exists so steam-user can persist machine-auth.
  mkdirSync(STEAM_SENTRY_DIR, { recursive: true });

  return new Promise<string>((resolve, reject) => {
    const client = new SteamUser({ dataDirectory: STEAM_SENTRY_DIR });

    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let rl: Interface | undefined;

    const armTimer = (ms: number, message: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(new Error(message)), ms);
      timer.unref?.();
    };

    const finish = (err: Error | null, ticket?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        rl?.close();
      } catch {
        /* ignore */
      }
      try {
        client.logOff();
      } catch {
        /* ignore logoff errors */
      }
      if (err) reject(err);
      else resolve(ticket as string);
    };

    if (debug) client.on("debug", (m: string) => console.log("[steam-debug]", m));

    // Prefer a saved refresh token for headless re-logins (no 2FA). Bootstrap is
    // interactive, so it always does a fresh credential login to (re)issue one.
    const savedRefresh = readSavedRefreshToken(config.steamUsername);
    const useRefresh = !!savedRefresh && !interactive;

    client.on("refreshToken", (rt: string) => {
      if (rt) {
        saveRefreshToken(config.steamUsername, rt);
        console.log("[steam] Saved a refresh token; future logins are headless (no 2FA needed).");
      }
    });

    armTimer(
      loginTimeoutMs,
      "Steam login timed out (never logged on). If your Steam app shows an Approve popup, tap Approve; " +
        "otherwise type the 5-character code from the app's Steam Guard screen.",
    );

    // Steam Guard: email code, or mobile authenticator (code AND/OR approve-in-app).
    client.on("steamGuard", (domain: string | null, callback: (code: string) => void, lastCodeWrong: boolean) => {
      if (!interactive) {
        finish(
          new Error(
            "Steam Guard required but running non-interactively. " +
              "Run `npm run bootstrap` locally to complete the one-time 2FA, then retry.",
          ),
        );
        return;
      }
      // IMPORTANT: steam-user cancels the device-approval ("Approve in app") flow and
      // requires a TYPED code (see steam-user components/09-logon.js: actionRequired ->
      // cancelLoginAttempt). Tapping APPROVE alone does nothing. For the mobile
      // authenticator the code is the rotating 5-character value in the app's Steam
      // Guard tab (not the login-approval popup).
      const where = domain
        ? `the email sent to ${domain}`
        : "the Steam app -> Steam Guard tab (the rotating 5-character code)";
      if (lastCodeWrong) console.log("[steam] That code was rejected. Read a FRESH one and type it promptly.");
      console.log(`[steam] Steam Guard code required. Tapping APPROVE is NOT enough; type the code from ${where}.`);
      const ask = () => {
        rl = createInterface({ input, output });
        rl.question("Steam Guard code: ")
          .then((answer) => {
            const code = answer.trim();
            try {
              rl?.close();
            } catch {
              /* ignore */
            }
            rl = undefined;
            if (!code) {
              console.log("[steam] No code entered. Type the 5-character code from the Steam Guard tab.");
              ask();
              return;
            }
            callback(code);
          })
          .catch((e) => finish(e as Error));
      };
      ask();
    });

    client.on("error", (err: Error) => {
      let e = err instanceof Error ? err : new Error(String(err));
      if (useRefresh) {
        e = new Error(
          `Headless login with the saved refresh token failed (${e.message}). ` +
            "It may have expired: re-run `npm run bootstrap` to refresh it.",
        );
      }
      finish(e);
    });

    client.on("loggedOn", () => {
      console.log("[steam] Logged on. Settling, then requesting the app auth session ticket...");
      // Login done: swap the long interactive budget for the ticket budget.
      armTimer(
        ticketTimeoutMs + settleSeconds * 1000,
        "Logged on but no auth session ticket arrived in time (app ownership or GC token issue). " +
          "Confirm this Steam account actually owns Boundless (app 324510).",
      );
      const settleTimer = setTimeout(() => {
        client.createAuthSessionTicket(
          STEAM_APP_ID,
          (err: Error | null, result?: Buffer | { sessionTicket?: Buffer }) => {
            if (err) {
              finish(err instanceof Error ? err : new Error(String(err)));
              return;
            }
            // stdlib's callbackPromise unwraps the single named value, so the 2nd
            // callback arg is the ticket Buffer itself, NOT { sessionTicket }.
            // Handle both shapes defensively.
            const ticket = Buffer.isBuffer(result) ? result : result?.sessionTicket;
            if (!ticket || ticket.length === 0) {
              finish(new Error("Empty Steam auth session ticket"));
              return;
            }
            console.log("[steam] Auth session ticket acquired.");
            finish(null, Buffer.from(ticket).toString("hex"));
          },
        );
      }, settleSeconds * 1000);
      settleTimer.unref?.();
    });

    if (useRefresh) {
      console.log("[steam] Logging on with the saved refresh token (headless)...");
      client.logOn({ refreshToken: savedRefresh as string });
    } else {
      console.log("[steam] Logging on with Steam credentials...");
      // rememberPassword:true => persist machine-auth alongside the refresh token.
      client.logOn({
        accountName: config.steamUsername,
        password: config.steamPassword,
        rememberPassword: true,
      });
    }
  });
}
