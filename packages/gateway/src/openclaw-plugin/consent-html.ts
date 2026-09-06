export function consentPage(input: {
  readonly clientId: string;
  readonly requestUri: string;
  readonly csrfToken: string;
  readonly tools: readonly string[];
  readonly defaultPolicyIndex: number;
  readonly policies: readonly {
    readonly label: string;
    readonly description?: string;
    readonly nativeCapabilities: readonly string[];
  }[];
}): string {
  const tools = input.tools.length
    ? `<ul>${input.tools.map((name) => `<li><code>${escapeHtml(name)}</code></li>`).join("")}</ul>`
    : "<p>No application tools requested.</p>";
  const policies = input.policies
    .map((policy, index) => {
      const capabilities = policy.nativeCapabilities.length
        ? policy.nativeCapabilities.map(humanCapability).join(", ")
        : "Application tools only";
      return `<label class="policy"><input type="radio" name="policy_choice" value="${index}"${index === input.defaultPolicyIndex ? " checked" : ""} required><strong>${escapeHtml(policy.label)}</strong><span>${escapeHtml(policy.description ?? capabilities)}</span><small>${escapeHtml(capabilities)}</small></label>`;
    })
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your AI</title><style>body{font:16px system-ui;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#18201d}code{overflow-wrap:anywhere}.policy{display:grid;grid-template-columns:auto 1fr;gap:.25rem .75rem;border:1px solid #ccd5d0;border-radius:.75rem;padding:1rem;margin:.75rem 0}.policy input{grid-row:1/4}.policy span,.policy small{grid-column:2}.actions{display:flex;gap:.75rem;margin-top:1.5rem}button{padding:.7rem 1rem;border-radius:.5rem;border:1px solid #52615a;background:white}button[value=allow]{background:#183f31;color:white}</style></head><body><main><h1>Connect your AI</h1><p><strong>${escapeHtml(input.clientId)}</strong> is asking to use this OpenClaw.</p><h2>Application tools</h2>${tools}<h2>OpenClaw capability policy</h2><form method="post" action="/agent-connect/oauth/authorize"><input type="hidden" name="request_uri" value="${escapeHtml(input.requestUri)}"><input type="hidden" name="csrf_token" value="${escapeHtml(input.csrfToken)}">${policies}<div class="actions"><button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></div></form></main></body></html>`;
}

export function errorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization unavailable</title></head><body><main><h1>Authorization unavailable</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] as string;
  });
}

function humanCapability(capability: string): string {
  if (capability === "public_web_search") return "Public web search";
  if (capability === "sandbox_code_execution") return "Isolated code sandbox";
  return capability;
}
