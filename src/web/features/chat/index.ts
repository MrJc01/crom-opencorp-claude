/** @jsxImportSource react */
export {
  SecretarioChat,
  ReasoningView,
  ToolCallView,
  type SecretarioChatProps,
} from "./components/SecretarioChat.js";

export {
  SecretarioDock,
  type SecretarioDockProps,
} from "./components/SecretarioDock.js";

export {
  GitStatusToolUI,
  HitlApprovalToolUI,
  TerminalExecToolUI,
} from "./components/AssistantTools.js";

export {
  useOpenCorpSecretarioRuntime,
  buildAssistantParts,
} from "./runtime/secretary-runtime-adapter.js";

export type {
  SecretaryRuntimeOptions,
  ToolExecutionItem,
  ChatSessionMetadata,
} from "./types.js";
