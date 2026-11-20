// RFC 6238 codes for the owner pages' TOTP path, from the base32 secret the
// enrollment page shows. Real codes, computed the way an authenticator app does.
import { createHmac } from "node:crypto";

export const totpStep = (now = Date.now()) => Math.floor(now / 30000);

export function totpCode(secret, step = totpStep()) {
  const bits = [...secret]
    .map((letter) =>
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        .indexOf(letter)
        .toString(2)
        .padStart(5, "0"),
    )
    .join("");
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest.at(-1) & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1e6)
    .toString()
    .padStart(6, "0");
}

/// The secret in an enrollment page's otpauth:// link.
export function enrollmentSecret(html) {
  const href = html.match(/href='(otpauth:\/\/[^']+)'/)?.[1];
  if (!href) throw new Error("Enrollment page carries no otpauth link");
  return new URL(href.replaceAll("&amp;", "&")).searchParams.get("secret");
}

/// Wait until the next 30-second step, so a fresh code differs from the last.
export async function nextTotpStep(after) {
  while (totpStep() <= after) await new Promise((ok) => setTimeout(ok, 500));
  return totpStep();
}

/// In the browser, from the setup page: choose the authenticator app, read the
/// key from the page and turn it on with a real code. Returns the secret and
/// the step its code used, since that step cannot be used again.
export async function setUpTotpInBrowser(page) {
  await page.getByRole("link", { name: /^Use an authenticator app/ }).click();
  const uri = await page
    .getByRole("link", { name: "Open in authenticator app" })
    .getAttribute("href");
  const secret = new URL(uri).searchParams.get("secret");
  const step = totpStep();
  await page
    .getByLabel("Code shown in your authenticator")
    .fill(totpCode(secret, step));
  await page.getByRole("button", { name: "Turn on", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes("/totp"));
  return { secret, step };
}
