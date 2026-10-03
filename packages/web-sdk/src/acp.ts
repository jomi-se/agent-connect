/**
 * @experimental Unstable ACP, MCP-over-ACP and Agent Connect resume APIs.
 * Shared application tools and session helpers retain their root-package API.
 */
import "./zod-jitless.js";

export { connectAgent, AcpProvider } from "./acp-provider.js";
export type {
  AcpGrant,
  ConnectAgentOptions,
  AcpRecovery,
} from "./acp-provider.js";
export { createAcpChatTransport } from "./acp-chat-transport.js";
export type {
  AcpChatTransport,
  AcpChatTransportOptions,
} from "./acp-chat-transport.js";
export {
  createResumableAcpStream,
  AcpTransportError,
} from "./resumable-acp-stream.js";
export type {
  ResumableAcpStreamOptions,
  ResumableAcpStream,
  AcpTransportSnapshot,
} from "./resumable-acp-stream.js";
export { createBrowserAcpStream } from "./transport.js";
export {
  McpOverAcpError,
  SingleMcpServer,
  defineTool,
} from "./single-mcp-server.js";
export { AgentConnectError, AgentSession } from "./agent-session.js";
export { createAgentChat, exportAgentChatMarkdown } from "./agent-chat.js";
export type {
  AgentChat,
  AgentChatOptions,
  AgentChatSnapshot,
  AgentChatMessage,
  AgentChatPart,
  AgentChatTextPart,
  AgentChatToolPart,
  AgentChatThoughtPart,
  AgentChatPlanPart,
  AgentChatProgressPart,
  AgentChatError,
} from "./agent-chat.js";
export { createWebMcpToolSnapshot } from "./webmcp.js";
export type {
  WebMcpToolSnapshot,
  WebMcpToolSnapshotOptions,
} from "./webmcp.js";
export type {
  AcpPlanEntry,
  AcpToolUpdate,
  ApplicationTool,
  ApplicationToolContext,
  ApplicationToolHandler,
  ApplicationToolResult,
  AgentConnectErrorCode,
  AgentProvider,
  AgentProviderEvent,
  AgentProviderTaskRequest,
  AgentSessionOptions,
  AgentTaskError,
  AgentTaskEvent,
  AgentTaskResult,
  AgentToolDefinition,
  BrowserAcpStream,
  BrowserAcpStreamOptions,
  JsonObject,
  JsonSchema,
  JsonValue,
  McpContent,
  SingleMcpServerOptions,
} from "./types.js";

export {
  createAcpPairing,
  AcpPairing,
  AcpPairingError,
  captureAcpPairingCallback,
} from "./acp-pairing.js";
export type {
  AcpPairingOptions,
  AcpPairingStorage,
  AcpPairingErrorCode,
  AcpManagedGrant,
} from "./acp-pairing.js";
