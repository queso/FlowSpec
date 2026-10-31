/**
 * Fixture API servers for `surface: api` tests, modeled on queso/silo.
 *
 * Two servers, each on its own free port, so absolute URLs and header
 * scoping across origins can be exercised:
 *
 * - porter: a label-buying service. Requests carry an API key in
 *   `Authorization: Bearer <key>`; each key has scopes. Quote and dry run
 *   need `labels:quote`; a buy needs `labels:buy`. A buy with a repeated
 *   `Idempotency-Key` replays the first result without calling the
 *   platform. A Shopify buy is asynchronous: the label goes from PENDING to
 *   PURCHASED over a few polls. A TikTok label record appears late: the
 *   first lookup after the buy answers 404.
 * - platform: a fake TikTok/Shopify platform that records the calls porter
 *   makes to it. `GET /__calls?path=&orderId=` counts them (orderId is
 *   optional) and `POST /__reset` clears them.
 *
 * porter also counts every request it receives (requestCount), which is how
 * tests prove a POST was sent exactly once, and serves a few `/__test/*`
 * helpers (echo, ordering marks, slow and non-JSON responses).
 */

import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Express, type Request, type Response } from "express";

export const QUOTE_SCOPE = "labels:quote";
export const BUY_SCOPE = "labels:buy";

/** The path porter calls on the platform for a TikTok buy. */
export const PLATFORM_PACKAGES_PATH = "/fulfillment/202309/packages";

/** Polls a Shopify label answers PENDING (202) before it is PURCHASED (200). */
export const SHOPIFY_PENDING_POLLS = 2;

/** The token `POST /__test/tokens` issues, for secret-capture tests. */
export const ISSUED_TOKEN = "tok_live_9f8e7d6c5b4a3210";

/** Text body over 500 bytes, for the non-JSON excerpt rule. */
export const LONG_TEXT_BODY = `${"0123456789".repeat(60)}TAIL-MARKER`;

export interface SiloFixtureOptions {
  /** API key to scopes. */
  keys: Record<string, string[]>;
}

export interface SiloFixture {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly porterUrl: string;
  readonly platformUrl: string;
  /** Requests porter has received for this method and path (query ignored). */
  requestCount(method: string, path: string): number;
  /** Every request porter has received, in order, as "METHOD /path". */
  readonly requestLog: readonly string[];
  /** Ordered `flow:event` entries recorded by `GET /__test/mark`. */
  readonly marks: readonly string[];
  /** Clears request counts, the request log and marks. Does not touch platform calls. */
  resetObservations(): void;
}

interface StoredResult {
  status: number;
  body: unknown;
}

function listen(app: Express): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function close(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function urlOf(server: Server | undefined): string {
  if (!server) {
    throw new Error("fixture server is not started");
  }
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createPlatformApp(): Express {
  const app = express();
  app.use(express.json());
  const calls: { path: string; body: unknown }[] = [];
  let nextPackage = 1;

  app.post(PLATFORM_PACKAGES_PATH, (req, res) => {
    calls.push({ path: req.path, body: req.body });
    res.json({ packageId: `pkg_${String(nextPackage++).padStart(4, "0")}` });
  });

  // `orderId` narrows the count to calls whose body lists that order, so a
  // flow can count only its own calls whatever other flows have done.
  app.get("/__calls", (req, res) => {
    const path = typeof req.query.path === "string" ? req.query.path : "";
    const orderId =
      typeof req.query.orderId === "string" ? req.query.orderId : undefined;
    const matching = calls.filter(
      (call) =>
        call.path === path &&
        (orderId === undefined ||
          (call.body as { orderIds?: unknown[] })?.orderIds?.includes(orderId)),
    );
    res.json({
      path,
      orderId: orderId ?? null,
      count: matching.length,
      calls: matching,
    });
  });

  app.post("/__reset", (_req, res) => {
    calls.length = 0;
    res.json({ reset: true });
  });

  app.all("/__echo", (req, res) => {
    res.json({ headers: req.headers });
  });

  return app;
}

function createPorterApp(
  options: SiloFixtureOptions,
  platformUrl: () => string,
  observations: { counts: Map<string, number>; log: string[]; marks: string[] },
): Express {
  const app = express();

  app.use((req, _res, next) => {
    const key = `${req.method} ${req.path}`;
    observations.counts.set(key, (observations.counts.get(key) ?? 0) + 1);
    observations.log.push(key);
    next();
  });
  app.use(express.json({ type: "application/json" }));
  app.use(express.text({ type: () => true }));

  const requireScope =
    (scope: string) =>
    (req: Request, res: Response, next: () => void): void => {
      const header = req.get("authorization") ?? "";
      const key = header.startsWith("Bearer ") ? header.slice(7) : "";
      const scopes = options.keys[key];
      if (!scopes) {
        res.status(401).json({ error: "unauthorized" });
        return;
      }
      if (!scopes.includes(scope)) {
        res.status(403).json({ error: "forbidden", missingScope: scope });
        return;
      }
      next();
    };

  // TikTok requires numeric fields as strings; a numeric weight is rejected.
  const invalidWeight = (body: unknown): boolean => {
    const weight = (body as { weight?: { value?: unknown } })?.weight;
    return typeof weight?.value !== "string";
  };

  app.post(
    "/tiktok/:shop/labels/quote",
    requireScope(QUOTE_SCOPE),
    (req, res) => {
      if (invalidWeight(req.body)) {
        res.status(422).json({ error: "weight.value must be a string" });
        return;
      }
      res.json({
        shop: req.params.shop,
        orderIds: req.body.orderIds,
        currency: "USD",
        amount: "1.25",
        amountNumber: 1.25,
      });
    },
  );

  const idempotent = new Map<string, StoredResult>();
  const tiktokLabels = new Map<string, { lookups: number }>();

  app.post(
    "/tiktok/:shop/labels",
    (req, res, next) =>
      requireScope(req.query.dryRun === "true" ? QUOTE_SCOPE : BUY_SCOPE)(
        req,
        res,
        next,
      ),
    async (req, res) => {
      if (invalidWeight(req.body)) {
        res.status(422).json({ error: "weight.value must be a string" });
        return;
      }

      if (req.query.dryRun === "true") {
        res.json({
          dryRun: true,
          wouldBuy: { orderIds: req.body.orderIds, carrier: "USPS" },
          amount: "1.25",
        });
        return;
      }

      const idempotencyKey = req.get("idempotency-key");
      const replay = idempotencyKey
        ? idempotent.get(idempotencyKey)
        : undefined;
      if (replay) {
        res.set("Idempotent-Replayed", "true");
        res.status(replay.status).json(replay.body);
        return;
      }

      const upstream = await fetch(
        `${platformUrl()}${PLATFORM_PACKAGES_PATH}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(req.body),
        },
      );
      const { packageId } = (await upstream.json()) as { packageId: string };
      const body = {
        packageId,
        orderIds: req.body.orderIds,
        trackingNumber: `TRK${packageId.slice(4)}`,
      };
      tiktokLabels.set(packageId, { lookups: 0 });
      if (idempotencyKey) {
        idempotent.set(idempotencyKey, { status: 200, body });
      }
      res.json(body);
    },
  );

  // The label record appears late: the first lookup after a buy is a 404.
  app.get(
    "/tiktok/:shop/labels/:packageId",
    requireScope(QUOTE_SCOPE),
    (req, res) => {
      const label = tiktokLabels.get(req.params.packageId);
      if (!label) {
        res.status(404).json({ error: "not found" });
        return;
      }
      label.lookups += 1;
      if (label.lookups === 1) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ packageId: req.params.packageId, status: "PURCHASED" });
    },
  );

  const shopifyLabels = new Map<string, { polls: number }>();
  let nextShopifyLabel = 1;

  app.post("/shopify/:shop/labels", requireScope(BUY_SCOPE), (_req, res) => {
    const labelId = `lbl_${nextShopifyLabel++}`;
    shopifyLabels.set(labelId, { polls: 0 });
    res.status(202).json({ labelId, status: "PENDING" });
  });

  app.get(
    "/shopify/:shop/labels/:labelId",
    requireScope(QUOTE_SCOPE),
    (req, res) => {
      const label = shopifyLabels.get(req.params.labelId);
      if (!label) {
        res.status(404).json({ error: "not found" });
        return;
      }
      label.polls += 1;
      if (label.polls <= SHOPIFY_PENDING_POLLS) {
        res
          .status(202)
          .json({ labelId: req.params.labelId, status: "PENDING" });
        return;
      }
      res.json({
        labelId: req.params.labelId,
        status: "PURCHASED",
        trackingNumber: `SHP${req.params.labelId.slice(4)}`,
      });
    },
  );

  // Echo for template and header tests.
  app.all(/^\/__test\/echo(\/.*)?$/, (req, res) => {
    res.set("X-Echo-Method", req.method);
    res.json({
      method: req.method,
      path: req.path,
      query: req.query,
      headers: req.headers,
      body: req.body,
      contentType: req.get("content-type") ?? null,
    });
  });

  app.get("/__test/mark", (req, res) => {
    observations.marks.push(`${req.query.flow}:${req.query.event}`);
    res.json({ marked: true });
  });

  app.get("/__test/slow", async (req, res) => {
    await sleep(Number(req.query.ms ?? 0));
    res.json({ slow: true });
  });

  // First request per key is slow, later ones are fast.
  const warmed = new Set<string>();
  app.get("/__test/warming", async (req, res) => {
    const key = String(req.query.key ?? "default");
    if (!warmed.has(key)) {
      warmed.add(key);
      await sleep(Number(req.query.ms ?? 300));
    }
    res.json({ warm: true });
  });

  // Counts calls per name; `ready` turns true on the third call.
  const sequences = new Map<string, number>();
  app.get("/__test/sequence/:name", (req, res) => {
    const n = (sequences.get(req.params.name) ?? 0) + 1;
    sequences.set(req.params.name, n);
    res.json({ n, ready: n >= 3 });
  });

  // Sends the request body back unchanged with the status from ?status=,
  // so a test controls exactly where each byte of the response body sits.
  app.post("/__test/reflect", (req, res) => {
    const body =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    res
      .status(Number(req.query.status ?? 200))
      .type("application/json")
      .send(body);
  });

  app.get("/__test/text", (_req, res) => {
    res.type("text/plain").send(LONG_TEXT_BODY);
  });

  app.post("/__test/tokens", (_req, res) => {
    res.status(201).json({ token: ISSUED_TOKEN });
  });

  app.get("/__test/whoami", (req, res) => {
    res.json({ authorization: req.get("authorization") ?? null });
  });

  return app;
}

export function createSiloFixture(options: SiloFixtureOptions): SiloFixture {
  let porter: Server | undefined;
  let platform: Server | undefined;
  const observations = {
    counts: new Map<string, number>(),
    log: [] as string[],
    marks: [] as string[],
  };

  const porterApp = createPorterApp(
    options,
    () => urlOf(platform),
    observations,
  );
  const platformApp = createPlatformApp();

  return {
    async start() {
      platform = await listen(platformApp);
      porter = await listen(porterApp);
    },
    async stop() {
      await close(porter);
      await close(platform);
      porter = undefined;
      platform = undefined;
    },
    get porterUrl() {
      return urlOf(porter);
    },
    get platformUrl() {
      return urlOf(platform);
    },
    requestCount(method: string, path: string) {
      return observations.counts.get(`${method.toUpperCase()} ${path}`) ?? 0;
    },
    get requestLog() {
      return observations.log;
    },
    get marks() {
      return observations.marks;
    },
    resetObservations() {
      observations.counts.clear();
      observations.log.length = 0;
      observations.marks.length = 0;
    },
  };
}
