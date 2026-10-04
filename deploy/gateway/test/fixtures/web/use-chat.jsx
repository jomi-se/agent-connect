import { createRoot } from "react-dom/client";
import { createElement } from "react";
import { AcpChatExample } from "../../../../../packages/web-sdk/examples/acp-use-chat.tsx";
export function mountChat(provider, tools) {
  const host = document.createElement("div");
  host.id = "use-chat";
  document.body.append(host);
  createRoot(host).render(createElement(AcpChatExample, { provider, tools }));
  window.addEventListener(
    "pagehide",
    (event) => {
      if (!event.persisted) provider.close();
    },
    { once: true },
  );
}
