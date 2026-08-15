/**
 * Test fixture server for FlowSpec E2E testing
 *
 * Serves static HTML files from the fixtures directory for browser-based tests.
 */

import type { Server } from "node:http";
import { join } from "node:path";
import express, { type Express } from "express";

const DEFAULT_PORT = 3456;
const DEFAULT_FIXTURES_DIR = join(__dirname, "fixtures", "pages");

/**
 * Configuration options for the test server
 */
export interface TestServerOptions {
  /** Port to listen on. Defaults to TEST_SERVER_PORT env var or 3456 */
  port?: number;
  /** Directory containing fixture files. Defaults to test/fixtures/pages */
  fixturesDir?: string;
}

/**
 * Test server interface for controlling the fixture server
 */
export interface TestServer {
  /** Start the server */
  start(): Promise<void>;
  /** Stop the server */
  stop(): Promise<void>;
  /** The port the server is listening on */
  readonly port: number;
  /** The base URL of the server (e.g., "http://localhost:3456") */
  readonly baseUrl: string;
}

/**
 * Create a test fixture server
 *
 * @param options - Server configuration options
 * @returns A TestServer instance
 */
export function createTestServer(options: TestServerOptions = {}): TestServer {
  const port = resolvePort(options.port);
  const fixturesDir = options.fixturesDir ?? DEFAULT_FIXTURES_DIR;

  const app = createExpressApp(fixturesDir);
  let httpServer: Server | null = null;

  return {
    get port() {
      return port;
    },

    get baseUrl() {
      return `http://localhost:${port}`;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer = app.listen(port);

        httpServer.once("listening", () => {
          resolve();
        });

        httpServer.once("error", (error: NodeJS.ErrnoException) => {
          httpServer = null;
          if (error.code === "EADDRINUSE") {
            reject(new Error(`Port ${port} is already in use`));
          } else {
            reject(error);
          }
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        if (!httpServer) {
          resolve();
          return;
        }

        const server = httpServer;
        httpServer = null;

        // Force close after timeout to handle hanging connections
        const forceCloseTimeout = setTimeout(() => {
          server.closeAllConnections?.();
        }, 5000);

        server.close(() => {
          clearTimeout(forceCloseTimeout);
          resolve();
        });
      });
    },
  };
}

/**
 * Resolve the port to use, with priority:
 * 1. Explicit port option
 * 2. TEST_SERVER_PORT environment variable
 * 3. Default port (3456)
 */
function resolvePort(explicitPort?: number): number {
  if (explicitPort !== undefined) {
    return explicitPort;
  }

  const envPort = process.env.TEST_SERVER_PORT;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return DEFAULT_PORT;
}

/**
 * Create the Express application with static file serving
 */
function createExpressApp(fixturesDir: string): Express {
  const app = express();

  // Per-app-instance recording state for the /record-header probe below.
  // Deliberately a closure variable rather than module state: origin-scoping
  // tests run two server instances at once, and each one has to answer for
  // what *it* received. `undefined` means no request has been recorded yet,
  // `null` means a request arrived carrying no header.
  let recordedHeader: string | null | undefined;

  // Echoes back a request header so browser-level tests can prove headers
  // are genuinely sent with the request. Client-side JS cannot read request
  // headers, so a static fixture could never verify this. Registered before
  // the static middleware so it is never shadowed by a fixture file.
  app.get("/echo-header", (req, res) => {
    const received = req.get("x-flowspec-test");
    const body = received ? `Header: ${received}` : "No header received";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Echo Header</title>
</head>
<body>
  <h1 id="echo">${body}</h1>
</body>
</html>
`,
    );
  });

  // Second echo route, same contract as /echo-header for a second header
  // name. Lets a single flow prove that two independently-supplied headers
  // both reached the server, without touching /echo-header's wording.
  app.get("/echo-header-2", (req, res) => {
    const received = req.get("x-flowspec-test-2");
    const body = received ? `Header 2: ${received}` : "No header 2 received";
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Echo Header 2</title>
</head>
<body>
  <h1 id="echo2">${body}</h1>
</body>
</html>
`,
    );
  });

  // Records whether the x-flowspec-test header rode along with a request, so
  // a *subresource* fetch (not a navigation) can be interrogated afterwards.
  // Answers 204 with no body: the browser never renders this, it only fetches
  // it. Repeated requests overwrite, which is the reset mechanism — plus
  // /reset-recorded-header below for tests that need to prove a request
  // genuinely arrived rather than inheriting a stale value.
  app.get("/record-header", (req, res) => {
    recordedHeader = req.get("x-flowspec-test") ?? null;
    res.status(204).end();
  });

  // Clears the recording so "Recorded: none" can only mean "a request arrived
  // and carried no header", never "nothing ever asked". Called directly by
  // tests over HTTP, not through the browser.
  app.get("/reset-recorded-header", (_req, res) => {
    recordedHeader = undefined;
    res.status(204).end();
  });

  // Renders what /record-header last saw, as a page the browser can assert on.
  app.get("/recorded-header", (_req, res) => {
    const body =
      recordedHeader === undefined
        ? "Recorded: unrecorded"
        : recordedHeader === null
          ? "Recorded: none"
          : `Recorded: ${recordedHeader}`;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Recorded Header</title>
</head>
<body>
  <h1 id="recorded">${body}</h1>
</body>
</html>
`,
    );
  });

  // Renders a page that immediately fetches `target` (a url-encoded absolute
  // URL, typically on a *different* origin) as a subresource, then reports
  // "probe complete" so a wait_for can synchronize on the fetch having
  // settled. This is how a cross-origin leak becomes observable: the header
  // either rode along with that subresource request or it did not.
  app.get("/cross-origin-probe", (req, res) => {
    const target = typeof req.query.target === "string" ? req.query.target : "";
    // JSON.stringify makes the URL a valid JS string literal; escaping "<"
    // additionally keeps a crafted target from closing the script element.
    const targetLiteral = JSON.stringify(target).replace(/</g, "\\u003c");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Cross Origin Probe</title>
</head>
<body>
  <h1 id="status">probe pending</h1>
  <script>
    fetch(${targetLiteral}, { mode: "no-cors" })
      .catch(function () {})
      .then(function () {
        document.getElementById("status").textContent = "probe complete";
      });
  </script>
</body>
</html>
`,
    );
  });

  // Serve static files with correct MIME types
  app.use(
    express.static(fixturesDir, {
      setHeaders: (res, path) => {
        if (path.endsWith(".html")) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
        }
      },
    }),
  );

  return app;
}
