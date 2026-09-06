import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { expect, it } from "vitest";
import {
  sendHtml,
  redirectAuthorization,
} from "../src/openclaw-plugin/http.js";
import { requireSameOrigin } from "../src/openclaw-plugin/oauth-utils.js";

it("real browser consent preserves Origin and returns to the application", async () => {
  let origin = "";
  let receivedOrigin: string | undefined;
  let callbackReferrer: string | undefined;
  const callback = createServer((request, response) => {
    callbackReferrer = request.headers.referer;
    response.end("Application callback");
  });
  await new Promise<void>((resolve) =>
    callback.listen(0, "127.0.0.1", resolve),
  );
  const address = callback.address();
  if (!address || typeof address === "string")
    throw new Error("no callback port");
  const callbackUrl = `http://127.0.0.1:${address.port}/callback`;
  const server = createServer((request, response) => {
    if (request.method === "POST") {
      receivedOrigin = request.headers.origin;
      try {
        requireSameOrigin(request, origin);
      } catch {
        response.writeHead(403);
        response.end("Rejected");
        return;
      }
      redirectAuthorization(response, callbackUrl, { code: "fixture-code" });
    } else {
      sendHtml(
        response,
        200,
        '<form method="post" action="/approve"><button>Allow fixture</button></form>',
        callbackUrl,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("no consent port");
  origin = `http://127.0.0.1:${bound.port}`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "Allow fixture" }).click();
    expect(receivedOrigin).toBe(origin);
    await page.waitForURL(`${callbackUrl}?code=fixture-code`, {
      timeout: 3000,
    });
    expect(callbackReferrer).toBeUndefined();
  } finally {
    await browser.close();
    await Promise.all([
      new Promise<void>((r) => server.close(() => r())),
      new Promise<void>((r) => callback.close(() => r())),
    ]);
  }
});
