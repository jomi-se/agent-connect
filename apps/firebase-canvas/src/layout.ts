export type DemoLayout = "desktop" | "mobile";

const STORED_LAYOUT = "agent-connect.demo-layout";

export function mountDemoLayout(): DemoLayout {
  const layout = selectLayout();
  const template = requireTemplate(`${layout}-layout`);
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing #app");

  root.replaceChildren(template.content.cloneNode(true));
  document.body.dataset["layout"] = layout;
  return layout;
}

function selectLayout(): DemoLayout {
  const forced = new URL(location.href).searchParams.get("view");
  if (forced === "mobile" || forced === "desktop") {
    sessionStorage.setItem(STORED_LAYOUT, forced);
    return forced;
  }

  const callback = new URL(location.href);
  const stored = sessionStorage.getItem(STORED_LAYOUT);
  if (
    (callback.searchParams.has("code") || callback.searchParams.has("error")) &&
    (stored === "mobile" || stored === "desktop")
  ) {
    return stored;
  }

  const phoneLike = matchMedia(
    "(max-width: 640px), (pointer: coarse) and (max-width: 950px)",
  ).matches;
  const selected = phoneLike ? "mobile" : "desktop";
  sessionStorage.setItem(STORED_LAYOUT, selected);
  return selected;
}

function requireTemplate(id: string): HTMLTemplateElement {
  const template = document.getElementById(id);
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error(`Missing #${id}`);
  }
  return template;
}
