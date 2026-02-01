/**
 * Test fixture server for FlowSpec E2E testing
 *
 * Serves static HTML files from the fixtures directory for browser-based tests.
 */

import express, { type Express } from 'express';
import { join } from 'node:path';
import type { Server } from 'node:http';

const DEFAULT_PORT = 3456;
const DEFAULT_FIXTURES_DIR = join(__dirname, 'fixtures', 'pages');

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

        httpServer.once('listening', () => {
          resolve();
        });

        httpServer.once('error', (error: NodeJS.ErrnoException) => {
          httpServer = null;
          if (error.code === 'EADDRINUSE') {
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
    if (!isNaN(parsed)) {
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

  // Serve static files with correct MIME types
  app.use(express.static(fixturesDir, {
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      }
    },
  }));

  return app;
}
