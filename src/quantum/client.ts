/**
 * QuantumFiber customer portal client.
 *
 * Auth is a two-hop SSO chain:
 *   1. GET login page  → extract Salesforce Aura fwuid + CSRF token
 *   2. POST credentials via Salesforce Aura → get frontdoor.jsp URL (with sid)
 *   3. GET frontdoor.jsp → sets Salesforce session cookie, HTTP-redirects to
 *      /QuantumFiber/s/redirectsfcccustom (a community LWC page)
 *   4. Parse that page for the community app's fwuid + token
 *   5. POST to fbr_apxRedirectController/getRedirectCustom → get SFCC OAuth URL
 *   6. GET the SFCC OAuth URL → establishes dwsid session on www.quantumfiber.com
 *   7. Call SFCC Demandware endpoints with the session cookie
 */

import { request, Agent } from "undici";

const LOGIN_ORIGIN = "https://login.quantumfiber.com";
const SFCC_ORIGIN = "https://www.quantumfiber.com";
const SFCC_BASE = `${SFCC_ORIGIN}/on/demandware.store/Sites-QFCC-Site/default`;

const MAX_REDIRECTS = 15;
const TIMEOUT_MS = 15_000;

export class QuantumFiberAPIError extends Error {
  readonly transport = "quantum" as const;
  readonly status?: number;
  constructor(message: string, opts: { status?: number } = {}) {
    super(message);
    this.name = "QuantumFiberAPIError";
    this.status = opts.status;
  }
}

export interface PlanStatus {
  productName: string;
  activePlan: {
    servicePlan: string;
    dataSpeed: string;
    dataSpeedValue: number;
    dataSpeedFormat: string;
  };
  upgradePlan?: {
    servicePlan: string;
    dataSpeed: string;
    dataSpeedValue: number;
    dataSpeedFormat: string;
    currentPlanPriceSFCC?: number;
  };
  changeOrderExist: boolean;
}

// Per-hostname cookie jar — no cross-domain leakage
class CookieJar {
  private store = new Map<string, Map<string, string>>();

  absorb(hostname: string, setCookieValues: string[]): void {
    for (const raw of setCookieValues) {
      const [nvPart] = raw.split(";");
      const eq = nvPart.indexOf("=");
      if (eq < 0) continue;
      const name = nvPart.slice(0, eq).trim();
      const value = nvPart.slice(eq + 1).trim();
      if (!this.store.has(hostname)) this.store.set(hostname, new Map());
      this.store.get(hostname)!.set(name, value);
    }
  }

  header(hostname: string): string {
    const jar = this.store.get(hostname);
    if (!jar?.size) return "";
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(hostname: string): boolean {
    return (this.store.get(hostname)?.size ?? 0) > 0;
  }

  clear(hostname: string): void {
    this.store.delete(hostname);
  }
}

type RespHeaders = Record<string, string | string[] | undefined>;

function setCookieArr(headers: RespHeaders): string[] {
  const val = headers["set-cookie"];
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
}

function locationOf(headers: RespHeaders): string | undefined {
  const loc = headers["location"];
  return Array.isArray(loc) ? loc[0] : loc;
}

interface FetchResult {
  status: number;
  headers: RespHeaders;
  body: string;
}

interface FollowResult {
  status: number;
  body: string;
  finalUrl: string;
}

export class QuantumFiberClient {
  private readonly username: string;
  private readonly password: string;
  private readonly dispatcher: Agent;
  private readonly jar = new CookieJar();
  private sessionEstablished = false;

  constructor(opts: { username: string; password: string }) {
    this.username = opts.username;
    this.password = opts.password;
    this.dispatcher = new Agent({
      connect: { rejectUnauthorized: true },
      keepAliveTimeout: 60_000,
      pipelining: 1,
    });
  }

  // ---- low-level fetch (no redirect following) ----

  private async rawFetch(
    url: string,
    init: {
      method?: string;
      body?: string;
      contentType?: string;
      accept?: string;
      extra?: Record<string, string>;
    } = {},
  ): Promise<FetchResult> {
    const { hostname } = new URL(url);
    const cookieHeader = this.jar.header(hostname);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const { statusCode, headers, body } = await request(url, {
        method: (init.method ?? "GET") as "GET" | "POST" | "HEAD",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
          Accept: init.accept ?? "*/*",
          "Accept-Language": "en-US,en;q=0.9",
          ...(init.contentType ? { "Content-Type": init.contentType } : {}),
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...init.extra,
        },
        body: init.body,
        dispatcher: this.dispatcher,
        maxRedirections: 0,
        signal: ctrl.signal,
      });
      this.jar.absorb(hostname, setCookieArr(headers));
      const text = await body.text();
      return { status: statusCode, headers, body: text };
    } finally {
      clearTimeout(t);
    }
  }

  // Follow HTTP redirects, updating the cookie jar per-host
  private async follow(
    url: string,
    init: Parameters<QuantumFiberClient["rawFetch"]>[1] = {},
    depth = 0,
  ): Promise<FollowResult> {
    if (depth > MAX_REDIRECTS)
      throw new QuantumFiberAPIError(`Too many redirects from ${url}`);
    const result = await this.rawFetch(url, depth === 0 ? init : {});
    if (result.status >= 300 && result.status < 400) {
      const loc = locationOf(result.headers);
      if (!loc) throw new QuantumFiberAPIError(`Redirect with no Location from ${url}`);
      const next = loc.startsWith("http") ? loc : new URL(loc, url).toString();
      return this.follow(next, {}, depth + 1);
    }
    return { status: result.status, body: result.body, finalUrl: url };
  }

  // ---- auth helpers ----

  private extractAuraCtx(
    html: string,
    contextLabel: string,
  ): { fwuid: string; auraToken: string; loaded: Record<string, string> } {
    const fwuidM = html.match(/"fwuid"\s*:\s*"([^"]+)"/);
    if (!fwuidM)
      throw new QuantumFiberAPIError(`fwuid not found in ${contextLabel}`);

    const tokenM = html.match(/"token"\s*:\s*"(eyJ[^"]+)"/);
    if (!tokenM)
      throw new QuantumFiberAPIError(`Aura token not found in ${contextLabel}`);

    const loadedM = html.match(/"loaded"\s*:\s*(\{[^}]+\})/);
    let loaded: Record<string, string> = {};
    if (loadedM) {
      try {
        loaded = JSON.parse(loadedM[1]) as Record<string, string>;
      } catch { /* fallback to empty */ }
    }

    return { fwuid: fwuidM[1], auraToken: tokenM[1], loaded };
  }

  private buildAuraBody(opts: {
    message: unknown;
    fwuid: string;
    app: string;
    loaded: Record<string, string>;
    pageURI: string;
    auraToken: string;
  }): string {
    return new URLSearchParams({
      message: JSON.stringify(opts.message),
      "aura.context": JSON.stringify({
        mode: "PROD",
        fwuid: opts.fwuid,
        app: opts.app,
        loaded: opts.loaded,
        dn: [],
        globals: {},
        uad: true,
      }),
      "aura.pageURI": opts.pageURI,
      "aura.token": opts.auraToken,
    }).toString();
  }

  // ---- Step 2: Salesforce Aura login ----

  private async auraLogin(
    fwuid: string,
    auraToken: string,
    loaded: Record<string, string>,
  ): Promise<string> {
    const body = this.buildAuraBody({
      message: {
        actions: [
          {
            id: "161;a",
            descriptor: "aura://ApexActionController/ACTION$execute",
            callingDescriptor: "UNKNOWN",
            params: {
              namespace: "",
              classname: "LWCLoginFormController",
              method: "login",
              params: {
                username: this.username,
                password: this.password,
                startUrl: `${LOGIN_ORIGIN}/QuantumFiber/s/`,
                pgNum: "noRedirect",
              },
              cacheable: false,
              isContinuation: false,
            },
          },
        ],
      },
      fwuid,
      app: "siteforce:loginApp2",
      loaded,
      pageURI: "/QuantumFiber/s/login/",
      auraToken,
    });

    const { status, body: respBody } = await this.rawFetch(
      `${LOGIN_ORIGIN}/QuantumFiber/s/sfsites/aura?r=7&aura.ApexAction.execute=1`,
      {
        method: "POST",
        body,
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        extra: {
          Origin: LOGIN_ORIGIN,
          Referer: `${LOGIN_ORIGIN}/QuantumFiber/s/login/`,
        },
      },
    );

    if (status !== 200)
      throw new QuantumFiberAPIError(`Aura login returned ${status}`, { status });

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(respBody) as Record<string, unknown>;
    } catch {
      throw new QuantumFiberAPIError("Invalid JSON in Aura login response");
    }

    const action = (json.actions as Array<Record<string, unknown>> | undefined)?.[0];
    if (action?.state !== "SUCCESS") {
      const err = (action?.error as Array<{ message?: string }> | undefined)?.[0];
      throw new QuantumFiberAPIError(`Salesforce auth failed: ${err?.message ?? "unknown"}`);
    }

    const frontdoorUrl = (action.returnValue as Record<string, unknown> | undefined)
      ?.returnValue;
    if (typeof frontdoorUrl !== "string")
      throw new QuantumFiberAPIError("No frontdoor URL in Aura login response");

    return frontdoorUrl;
  }

  // ---- Step 5: get SFCC OAuth URL from the community redirect page ----

  private async callGetRedirectCustom(
    fwuid: string,
    auraToken: string,
    loaded: Record<string, string>,
  ): Promise<string> {
    const body = this.buildAuraBody({
      message: {
        actions: [
          {
            id: "127;a",
            descriptor: "apex://fbr_apxRedirectController/ACTION$getRedirectCustom",
            callingDescriptor: "markup://c:fbr_cmpRedirectPageCustom",
            params: { pg_number: 1 },
          },
        ],
      },
      fwuid,
      app: "siteforce:communityApp",
      loaded,
      pageURI: "/QuantumFiber/s/redirectsfcccustom",
      auraToken,
    });

    const { status, body: respBody } = await this.rawFetch(
      `${LOGIN_ORIGIN}/QuantumFiber/s/sfsites/aura?r=4&other.fbr_apxRedirect.getRedirectCustom=1`,
      {
        method: "POST",
        body,
        contentType: "application/x-www-form-urlencoded;charset=UTF-8",
        extra: {
          Origin: LOGIN_ORIGIN,
          Referer: `${LOGIN_ORIGIN}/QuantumFiber/s/redirectsfcccustom`,
        },
      },
    );

    if (status !== 200)
      throw new QuantumFiberAPIError(`getRedirectCustom returned ${status}`, { status });

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(respBody) as Record<string, unknown>;
    } catch {
      throw new QuantumFiberAPIError("Invalid JSON from getRedirectCustom");
    }

    const sfccUrl = (json.actions as Array<Record<string, unknown>> | undefined)?.[0]?.returnValue;
    if (typeof sfccUrl !== "string")
      throw new QuantumFiberAPIError("No SFCC OAuth URL from getRedirectCustom");

    return sfccUrl;
  }

  // ---- Full login flow ----

  async login(): Promise<void> {
    this.sessionEstablished = false;
    this.jar.clear("login.quantumfiber.com");
    this.jar.clear("www.quantumfiber.com");

    // 1. Login page — get Aura auth context
    const loginPageResult = await this.rawFetch(`${LOGIN_ORIGIN}/QuantumFiber/s/login/`, {
      accept: "text/html,application/xhtml+xml,*/*",
    });
    if (loginPageResult.status !== 200)
      throw new QuantumFiberAPIError(`Login page returned ${loginPageResult.status}`);
    const { fwuid, auraToken, loaded } = this.extractAuraCtx(
      loginPageResult.body,
      "login page",
    );

    // 2. POST credentials → get frontdoor.jsp URL
    const frontdoorUrl = await this.auraLogin(fwuid, auraToken, loaded);

    // 3. GET frontdoor.jsp → Salesforce sets session cookie → HTTP-redirects to
    //    /QuantumFiber/s/redirectsfcccustom (a community page, not a JS redirect)
    const communityPage = await this.follow(frontdoorUrl, {
      accept: "text/html,application/xhtml+xml,*/*",
    });

    if (!communityPage.finalUrl.includes("redirectsfcccustom"))
      throw new QuantumFiberAPIError(
        `Expected redirectsfcccustom page, landed on: ${communityPage.finalUrl}`,
      );

    // 4. Parse community page for its Aura context
    const communityCtx = this.extractAuraCtx(communityPage.body, "community page");

    // 5. Call getRedirectCustom → get the SFCC OAuth URL
    const sfccOAuthUrl = await this.callGetRedirectCustom(
      communityCtx.fwuid,
      communityCtx.auraToken,
      communityCtx.loaded,
    );

    // 6. Follow the SFCC OAuth URL → SFCC validates the OAuth token, sets dwsid cookie
    await this.follow(sfccOAuthUrl, {
      accept: "text/html,application/xhtml+xml,*/*",
    });

    if (!this.jar.has("www.quantumfiber.com"))
      throw new QuantumFiberAPIError("Login did not establish a QuantumFiber.com session");

    this.sessionEstablished = true;
  }

  // ---- Public API ----

  private async getPlanStatusOnce(login = true): Promise<PlanStatus> {
    if (!this.sessionEstablished) {
      if (!login) throw new QuantumFiberAPIError("Not authenticated");
      await this.login();
    }

    const { status, body } = await this.rawFetch(`${SFCC_BASE}/MPHome-GetMaxSpeed`, {
      extra: { "X-Requested-With": "XMLHttpRequest" },
      accept: "application/json, text/javascript, */*",
    });

    // Session expired — re-login once
    if ((status === 302 || status === 401 || status === 403) && login) {
      this.sessionEstablished = false;
      return this.getPlanStatusOnce(false);
    }

    if (status !== 200)
      throw new QuantumFiberAPIError(`MPHome-GetMaxSpeed returned ${status}`, { status });

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new QuantumFiberAPIError("Invalid JSON from MPHome-GetMaxSpeed");
    }

    if (!data.loggedin) {
      if (login) {
        // Portal returned 200 but unauthenticated — re-login once
        this.sessionEstablished = false;
        return this.getPlanStatusOnce(false);
      }
      throw new QuantumFiberAPIError("QuantumFiber session not authenticated (loggedin=false)");
    }

    if (!data.success)
      throw new QuantumFiberAPIError("MPHome-GetMaxSpeed returned success=false");

    return {
      productName: String(data.productName ?? "Fiber Internet"),
      activePlan: data.activePlan as PlanStatus["activePlan"],
      upgradePlan: data.upgradePlan as PlanStatus["upgradePlan"] | undefined,
      changeOrderExist: Boolean(data.changeOrderExist),
    };
  }

  async getPlanStatus(): Promise<PlanStatus> {
    return this.getPlanStatusOnce();
  }

  /** Reachability probe for diagnostics. */
  async ping(): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
    const start = Date.now();
    try {
      await this.getPlanStatus();
      return { ok: true, latencyMs: Date.now() - start };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e),
      };
    }
  }
}
