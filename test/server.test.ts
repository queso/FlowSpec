/**
 * Test fixture server tests for FlowSpec
 *
 * These tests verify that the test fixture server works correctly for
 * serving static HTML files during E2E testing.
 */

import { afterEach, describe, expect, it } from "vitest";

// The server module to be implemented
import { createTestServer, type TestServer } from "./server";

describe("Test Fixture Server", () => {
  let server: TestServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it("should export createTestServer function with start/stop methods", () => {
    expect(typeof createTestServer).toBe("function");
    server = createTestServer();
    expect(typeof server.start).toBe("function");
    expect(typeof server.stop).toBe("function");
  });

  it("should start on default port 3456", async () => {
    server = createTestServer();
    await server.start();

    expect(server.port).toBe(3456);
    expect(server.baseUrl).toBe("http://localhost:3456");
  });

  it("should serve HTML fixture files", async () => {
    server = createTestServer();
    await server.start();

    const response = await fetch(`${server.baseUrl}/login.html`);
    expect(response.ok).toBe(true);

    const html = await response.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("<title>Login</title>");
  });

  it("should return 404 for non-existent files", async () => {
    server = createTestServer();
    await server.start();

    const response = await fetch(`${server.baseUrl}/nonexistent.html`);
    expect(response.status).toBe(404);
  });

  it("should stop cleanly and allow restart", async () => {
    server = createTestServer();
    await server.start();
    await server.stop();

    // Should be able to start again
    server = createTestServer();
    await server.start();
  });
});
