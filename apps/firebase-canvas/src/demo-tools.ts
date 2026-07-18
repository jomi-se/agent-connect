import { defineTool, type ApplicationTool } from "@agent-connect/web";

export type DemoScenario =
  "project-board" | "document-review" | "product-research";

export const DEFAULT_PROMPTS: Readonly<Record<DemoScenario, string>> = {
  "project-board":
    "Turn these launch notes into a realistic plan. Add the missing work, fix priorities, and move tasks into the right columns.",
  "document-review":
    "Review this draft. Flag the factual error and unclear writing, suggest better wording, and apply the strongest fixes in place.",
  "product-research":
    "Is this a sensible pair of headphones for an eight-year-old? Check safety, whether the price is fair, and show better alternatives.",
};

export const SCENARIO_TOOL_NAMES: Readonly<
  Record<DemoScenario, readonly string[]>
> = {
  "project-board": [
    "create_project_tasks",
    "update_project_tasks",
    "move_project_tasks",
  ],
  "document-review": [
    "add_document_comments",
    "replace_document_text",
    "format_document_blocks",
  ],
  "product-research": [
    "add_product_assessment",
    "add_price_comparison",
    "add_product_alternatives",
  ],
};

export function createDemoTools(): readonly ApplicationTool[] {
  return [
    defineTool({
      name: "create_project_tasks",
      description: "Add several tasks to the project board.",
      inputSchema: {
        type: "object",
        properties: {
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                priority: { enum: ["high", "medium", "low"] },
                status: { enum: ["backlog", "doing", "done"] },
              },
              required: ["id", "title", "priority", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["tasks"],
        additionalProperties: false,
      },
      execute: ({ tasks }) => {
        const parsedTasks = requireObjectArray(tasks, "tasks");
        for (const task of parsedTasks) {
          const id = requireString(task, "id");
          if (document.querySelector(`[data-task-id="${cssEscape(id)}"]`))
            continue;
          const renderedTask = renderTask(
            id,
            requireString(task, "title"),
            requirePriority(task["priority"]),
          );
          taskList(requireStatus(task["status"])).append(renderedTask);
          animateAppMutation(renderedTask, "pop");
        }
        markSurfaceChanged("project-board");
        return toolResult("Project tasks added.", {
          created: parsedTasks.length,
        });
      },
    }),
    defineTool({
      name: "update_project_tasks",
      description: "Change titles or priorities of existing project tasks.",
      inputSchema: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                priority: { enum: ["high", "medium", "low"] },
              },
              required: ["id"],
              additionalProperties: false,
            },
          },
        },
        required: ["changes"],
        additionalProperties: false,
      },
      execute: ({ changes }) => {
        const parsedChanges = requireObjectArray(changes, "changes");
        for (const change of parsedChanges) {
          const task = requireTask(requireString(change, "id"));
          if (typeof change["title"] === "string") {
            requireDescendant(task, "[data-task-title]").textContent =
              change["title"];
          }
          if (change["priority"] !== undefined) {
            setTaskPriority(task, requirePriority(change["priority"]));
          }
          animateAppMutation(task, "update");
        }
        markSurfaceChanged("project-board");
        return toolResult("Project tasks updated.", {
          updated: parsedChanges.length,
        });
      },
    }),
    defineTool({
      name: "move_project_tasks",
      description: "Move existing project tasks between board columns.",
      inputSchema: {
        type: "object",
        properties: {
          moves: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                status: { enum: ["backlog", "doing", "done"] },
              },
              required: ["id", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["moves"],
        additionalProperties: false,
      },
      execute: ({ moves }) => {
        const parsedMoves = requireObjectArray(moves, "moves");
        for (const move of parsedMoves) {
          const task = requireTask(requireString(move, "id"));
          const previousPosition = task.getBoundingClientRect();
          taskList(requireStatus(move["status"])).append(task);
          animateMovedElement(task, previousPosition);
        }
        markSurfaceChanged("project-board");
        return toolResult("Project tasks moved.", {
          moved: parsedMoves.length,
        });
      },
    }),
    defineTool({
      name: "add_document_comments",
      description:
        "Attach review comments to exact quoted passages in the document.",
      inputSchema: {
        type: "object",
        properties: {
          comments: {
            type: "array",
            items: {
              type: "object",
              properties: {
                quote: { type: "string" },
                kind: { enum: ["fact", "clarity", "style"] },
                comment: { type: "string" },
              },
              required: ["quote", "kind", "comment"],
              additionalProperties: false,
            },
          },
        },
        required: ["comments"],
        additionalProperties: false,
      },
      execute: ({ comments }) => {
        const parsedComments = requireObjectArray(comments, "comments");
        const list = requireElement<HTMLElement>("review-comments");
        list.replaceChildren();
        for (const comment of parsedComments) {
          const quote = requireString(comment, "quote");
          const target = findQuote(quote);
          target.dataset["reviewKind"] = requireReviewKind(comment["kind"]);
          animateAppMutation(target, "review");
          const item = document.createElement("li");
          const strong = document.createElement("strong");
          strong.textContent = requireReviewKind(comment["kind"]);
          const text = document.createElement("span");
          text.textContent = requireString(comment, "comment");
          item.append(strong, text);
          list.append(item);
          animateAppMutation(item, "pop");
        }
        markSurfaceChanged("document-review");
        return toolResult("Review comments added.", {
          comments: parsedComments.length,
        });
      },
    }),
    defineTool({
      name: "replace_document_text",
      description: "Replace exact quoted passages in the open document.",
      inputSchema: {
        type: "object",
        properties: {
          replacements: {
            type: "array",
            items: {
              type: "object",
              properties: {
                quote: { type: "string" },
                replacement: { type: "string" },
              },
              required: ["quote", "replacement"],
              additionalProperties: false,
            },
          },
        },
        required: ["replacements"],
        additionalProperties: false,
      },
      execute: ({ replacements }) => {
        const parsedReplacements = requireObjectArray(
          replacements,
          "replacements",
        );
        for (const replacement of parsedReplacements) {
          const target = findQuote(requireString(replacement, "quote"));
          target.textContent = requireString(replacement, "replacement");
          delete target.dataset["reviewKind"];
          animateAppMutation(target, "rewrite");
        }
        markSurfaceChanged("document-review");
        return toolResult("Document text replaced.", {
          replaced: parsedReplacements.length,
        });
      },
    }),
    defineTool({
      name: "format_document_blocks",
      description: "Apply semantic formatting to exact document blocks.",
      inputSchema: {
        type: "object",
        properties: {
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                blockId: { type: "string" },
                format: { enum: ["heading", "paragraph", "callout"] },
              },
              required: ["blockId", "format"],
              additionalProperties: false,
            },
          },
        },
        required: ["blocks"],
        additionalProperties: false,
      },
      execute: ({ blocks }) => {
        const parsedBlocks = requireObjectArray(blocks, "blocks");
        for (const block of parsedBlocks) {
          const element = requireElement<HTMLElement>(
            `document-block-${requireString(block, "blockId")}`,
          );
          element.dataset["format"] = requireBlockFormat(block["format"]);
          animateAppMutation(element, "format");
        }
        markSurfaceChanged("document-review");
        return toolResult("Document formatting applied.", {
          formatted: parsedBlocks.length,
        });
      },
    }),
    defineTool({
      name: "add_product_assessment",
      description:
        "Add a child-suitability assessment and safety concerns to the product page.",
      inputSchema: {
        type: "object",
        properties: {
          verdict: { type: "string" },
          kidFit: { enum: ["good", "mixed", "poor"] },
          concerns: { type: "array", items: { type: "string" } },
        },
        required: ["verdict", "kidFit", "concerns"],
        additionalProperties: false,
      },
      execute: ({ verdict, kidFit, concerns }) => {
        requireElement("product-verdict").textContent = requireText(
          verdict,
          "verdict",
        );
        const fit = requireElement("product-kid-fit");
        fit.textContent = requireKidFit(kidFit);
        fit.dataset["fit"] = requireKidFit(kidFit);
        renderStringList("product-concerns", concerns, "concerns");
        revealProductResearch();
        animateAppMutation(requireElement("product-verdict"), "reveal");
        animateAppMutation(fit, "pop", 90);
        animateListChildren(requireElement("product-concerns"), 130);
        return toolResult("Product assessment added.", { kidFit });
      },
    }),
    defineTool({
      name: "add_price_comparison",
      description:
        "Add recorded pricing context and a fair-price verdict to the product page.",
      inputSchema: {
        type: "object",
        properties: {
          listedPrice: { type: "number" },
          fairLow: { type: "number" },
          fairHigh: { type: "number" },
          verdict: { type: "string" },
        },
        required: ["listedPrice", "fairLow", "fairHigh", "verdict"],
        additionalProperties: false,
      },
      execute: ({ listedPrice, fairLow, fairHigh, verdict }) => {
        requireElement("product-price-range").textContent =
          `€${requireNumber(fairLow)}–€${requireNumber(fairHigh)}`;
        requireElement("product-price-note").textContent = requireText(
          verdict,
          "verdict",
        );
        requireElement("product-listed-price").textContent =
          `€${requireNumber(listedPrice)}`;
        revealProductResearch();
        animateAppMutation(requireElement("product-price-range"), "pop");
        animateAppMutation(requireElement("product-price-note"), "reveal", 80);
        animateAppMutation(
          requireElement("product-listed-price"),
          "update",
          120,
        );
        return toolResult("Price comparison added.", { fairLow, fairHigh });
      },
    }),
    defineTool({
      name: "add_product_alternatives",
      description:
        "Add researched alternative products and source links to the product page.",
      inputSchema: {
        type: "object",
        properties: {
          alternatives: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                price: { type: "number" },
                reason: { type: "string" },
                url: { type: "string" },
              },
              required: ["name", "price", "reason", "url"],
              additionalProperties: false,
            },
          },
        },
        required: ["alternatives"],
        additionalProperties: false,
      },
      execute: ({ alternatives }) => {
        const parsedAlternatives = requireObjectArray(
          alternatives,
          "alternatives",
        );
        const list = requireElement("product-alternatives");
        list.replaceChildren();
        for (const alternative of parsedAlternatives) {
          const item = document.createElement("li");
          const link = document.createElement("a");
          link.textContent = requireString(alternative, "name");
          link.href = requireSafeUrl(alternative["url"]);
          link.target = "_blank";
          link.rel = "noreferrer";
          const price = document.createElement("strong");
          price.textContent = `€${requireNumber(alternative["price"])}`;
          const reason = document.createElement("span");
          reason.textContent = requireString(alternative, "reason");
          item.append(link, price, reason);
          list.append(item);
        }
        revealProductResearch();
        animateListChildren(list, 40);
        return toolResult("Product alternatives added.", {
          alternatives: parsedAlternatives.length,
        });
      },
    }),
  ];
}

function taskList(status: string): HTMLElement {
  return requireElement(`task-list-${status}`);
}

function requireTask(id: string): HTMLElement {
  const task = document.querySelector<HTMLElement>(
    `[data-task-id="${cssEscape(id)}"]`,
  );
  if (!task) throw new Error(`Unknown task ${id}`);
  return task;
}

function renderTask(
  id: string,
  title: string,
  priority: string,
): HTMLLIElement {
  const item = document.createElement("li");
  item.dataset["taskId"] = id;
  const titleElement = document.createElement("span");
  titleElement.dataset["taskTitle"] = "";
  titleElement.textContent = title;
  const priorityElement = document.createElement("small");
  priorityElement.dataset["taskPriority"] = priority;
  priorityElement.textContent = priority;
  item.append(titleElement, priorityElement);
  return item;
}

function setTaskPriority(task: HTMLElement, priority: string): void {
  const element = requireDescendant(task, "[data-task-priority]");
  element.dataset["taskPriority"] = priority;
  element.textContent = priority;
}

function findQuote(quote: string): HTMLElement {
  const normalizedQuote = normalizeWhitespace(quote);
  const match = [
    ...document.querySelectorAll<HTMLElement>("[data-review-quote]"),
  ].find(
    (element) =>
      normalizeWhitespace(element.textContent ?? "") === normalizedQuote ||
      element.dataset["originalQuote"] === quote,
  );
  if (!match) throw new Error(`Quoted text is no longer present: ${quote}`);
  match.dataset["originalQuote"] ??= quote;
  return match;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function revealProductResearch(): void {
  const results = requireElement("product-research-results");
  const firstReveal = results.hidden;
  results.hidden = false;
  if (firstReveal) animateAppMutation(results, "panel");
  markSurfaceChanged("product-research");
}

function markSurfaceChanged(scenario: DemoScenario): void {
  requireElement(`scenario-${scenario}`).dataset["changed"] = "true";
}

function renderStringList(id: string, value: unknown, label: string): void {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new TypeError(`${label} must be an array of strings`);
  }
  const list = requireElement(id);
  list.replaceChildren(
    ...value.map((text) =>
      Object.assign(document.createElement("li"), { textContent: text }),
    ),
  );
}

function toolResult(text: string, structuredContent: Record<string, unknown>) {
  void structuredContent;
  return {
    content: [{ type: "text" as const, text }],
  };
}

function requireObjectArray(
  value: unknown,
  label: string,
): Record<string, unknown>[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== "object" || item === null || Array.isArray(item),
    )
  ) {
    throw new TypeError(`${label} must be an array of objects`);
  }
  return value as Record<string, unknown>[];
}

function requireString(value: Record<string, unknown>, key: string): string {
  return requireText(value[key], key);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError(`${label} must be a string`);
  return value;
}

function requireNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new TypeError("Expected a finite number");
  return value;
}

function requirePriority(value: unknown): "high" | "medium" | "low" {
  if (value !== "high" && value !== "medium" && value !== "low")
    throw new TypeError("Invalid priority");
  return value;
}

function requireStatus(value: unknown): "backlog" | "doing" | "done" {
  if (value !== "backlog" && value !== "doing" && value !== "done")
    throw new TypeError("Invalid status");
  return value;
}

function requireReviewKind(value: unknown): "fact" | "clarity" | "style" {
  if (value !== "fact" && value !== "clarity" && value !== "style")
    throw new TypeError("Invalid review kind");
  return value;
}

function requireBlockFormat(
  value: unknown,
): "heading" | "paragraph" | "callout" {
  if (value !== "heading" && value !== "paragraph" && value !== "callout")
    throw new TypeError("Invalid block format");
  return value;
}

function requireKidFit(value: unknown): "good" | "mixed" | "poor" {
  if (value !== "good" && value !== "mixed" && value !== "poor")
    throw new TypeError("Invalid kid fit");
  return value;
}

function requireSafeUrl(value: unknown): string {
  const url = new URL(requireText(value, "url"));
  if (url.protocol !== "https:")
    throw new TypeError("Alternative URL must use HTTPS");
  return url.href;
}

type AppMutationKind =
  "pop" | "update" | "review" | "rewrite" | "format" | "reveal" | "panel";

function animateAppMutation(
  element: HTMLElement,
  kind: AppMutationKind,
  delay = 0,
): void {
  if (!appMotionEnabled()) return;
  const common: KeyframeAnimationOptions = {
    duration: kind === "panel" ? 620 : 520,
    delay,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  };
  const frames: Readonly<Record<AppMutationKind, Keyframe[]>> = {
    pop: [
      { opacity: 0, transform: "translateY(12px) scale(0.86)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    update: [
      {
        backgroundColor: "oklch(0.94 0.035 32.1)",
        boxShadow: "0 0 0 5px oklch(0.56 0.16 32.1 / 0.18)",
        transform: "scale(1.025)",
      },
      {
        backgroundColor: "transparent",
        boxShadow: "none",
        transform: "scale(1)",
      },
    ],
    review: [
      {
        boxShadow: "0 0 0 5px oklch(0.79 0.14 83 / 0.22)",
        filter: "brightness(1.04)",
      },
      { boxShadow: "none", filter: "brightness(1)" },
    ],
    rewrite: [
      {
        opacity: 0.3,
        filter: "blur(2px)",
        backgroundColor: "oklch(0.96 0.04 83)",
      },
      { opacity: 1, filter: "blur(0)", backgroundColor: "transparent" },
    ],
    format: [
      {
        transform: "scale(0.985)",
        boxShadow: "0 0 0 5px oklch(0.52 0.15 275 / 0.16)",
      },
      { transform: "scale(1)", boxShadow: "none" },
    ],
    reveal: [
      { opacity: 0, transform: "translateY(10px)" },
      { opacity: 1, transform: "translateY(0)" },
    ],
    panel: [
      {
        opacity: 0,
        transform: "translateX(24px)",
        clipPath: "inset(0 0 0 22%)",
      },
      { opacity: 1, transform: "translateX(0)", clipPath: "inset(0 0 0 0)" },
    ],
  };
  element.animate(frames[kind], common);
}

function animateMovedElement(
  element: HTMLElement,
  previousPosition: DOMRect,
): void {
  if (!appMotionEnabled()) return;
  const nextPosition = element.getBoundingClientRect();
  const deltaX = previousPosition.left - nextPosition.left;
  const deltaY = previousPosition.top - nextPosition.top;
  element.animate(
    [
      {
        transform: `translate(${deltaX}px, ${deltaY}px) scale(1.035)`,
        boxShadow: "0 10px 20px oklch(0.2 0.018 250 / 0.18)",
        zIndex: 4,
      },
      {
        transform: "translate(0, 0) scale(1)",
        boxShadow: "0 1px 3px oklch(0.2 0.018 250 / 0.06)",
        zIndex: 1,
      },
    ],
    {
      duration: 680,
      easing: "cubic-bezier(0.22, 1, 0.36, 1)",
    },
  );
}

function animateListChildren(list: HTMLElement, initialDelay: number): void {
  for (const [index, child] of [...list.children].entries()) {
    if (child instanceof HTMLElement) {
      animateAppMutation(child, "pop", initialDelay + index * 70);
    }
  }
}

function appMotionEnabled(): boolean {
  return !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function requireElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function requireDescendant(parent: HTMLElement, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function cssEscape(value: string): string {
  return CSS.escape(value);
}
