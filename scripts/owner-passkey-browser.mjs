// Chromium's virtual authenticator for the owner pages: real WebAuthn in the
// browser and real signatures, with no device. Each tab gets its own
// authenticator, so the credentials live here and are loaded into a tab before
// each ceremony and read back after, which keeps one owner's passkeys (and
// their signature counters) consistent across tabs.

export function ownerPasskeys() {
  const credentials = new Map();
  const attached = new WeakMap();

  async function authenticator(page) {
    if (!attached.has(page)) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send(
        "WebAuthn.addVirtualAuthenticator",
        {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        },
      );
      attached.set(page, { cdp, authenticatorId });
    }
    return attached.get(page);
  }

  /// Run `action` (which triggers one ceremony) with the owner's passkeys in
  /// this tab, then keep what the ceremony created or counted.
  async function use(page, action) {
    const { cdp, authenticatorId } = await authenticator(page);
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    for (const credential of credentials.values())
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
    let result;
    try {
      result = await action();
    } catch (error) {
      // Say where the ceremony ended: the gateway's error page or the form's
      // passkey status line.
      const said = await page
        .locator("h1, .passkey-status, .lede")
        .allInnerTexts()
        .catch(() => []);
      throw new Error(
        `Passkey ceremony did not finish at ${page.url()}: ${said.filter(Boolean).join(" | ")}`,
        { cause: error },
      );
    }
    const { credentials: now } = await cdp.send("WebAuthn.getCredentials", {
      authenticatorId,
    });
    for (const credential of now)
      credentials.set(credential.credentialId, credential);
    return result;
  }

  return {
    use,
    /// Relying parties (hostnames) the owner holds a passkey for.
    relyingParties: () => [...credentials.values()].map(({ rpId }) => rpId),
    /// Forget one address's passkey, as a lost device would.
    forget(rpId) {
      for (const [id, credential] of credentials)
        if (credential.rpId === rpId) credentials.delete(id);
    },
  };
}

/// Sign in on the page's address the way it asks: with the passkey, or with
/// the passphrase and then a new passkey on an address that has none. Ends on
/// the page the sign-in leads to.
export async function passkeySignIn(page, passkeys, { owner, password }) {
  await page.goto(owner);
  const passkeyButton = page.getByRole("button", {
    name: "Sign in with your passkey",
    exact: true,
  });
  const passphrase = page.getByLabel("Passphrase", { exact: true });
  await passkeyButton.or(passphrase).first().waitFor();
  if (await passkeyButton.isVisible()) {
    await passkeys.use(page, () =>
      Promise.all([
        page.waitForURL((url) => !url.pathname.endsWith("/login")),
        passkeyButton.click(),
      ]),
    );
    return;
  }
  await passphrase.fill(password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const create = page.getByRole("button", {
    name: "Create a passkey",
    exact: true,
  });
  await create.waitFor();
  await passkeys.use(page, () =>
    Promise.all([
      page.waitForURL((url) => !url.pathname.endsWith("/setup")),
      create.click(),
    ]),
  );
}
