export type RuntimeProvider = 'openai' | 'ollama' | 'vllm' | 'osirus' | 'osirus_agent' | 'openai_compatible';
export type AuthMode = 'chatgpt' | 'api_key' | 'none';
export type AgentExecutionClass = 'native_tools' | 'model_tools' | 'bridge_tools';
export type AgentExecutionReadiness = 'ready' | 'experimental' | 'planned';

export type AgentRuntimeCapability = {
  contract: 'codex_agent';
  executionClass: AgentExecutionClass;
  readiness: AgentExecutionReadiness;
  supportsWorkspaceActions: boolean;
  supportsDirectFileEdits: boolean;
  supportsCommandExecution: boolean;
  supportsGitInspection: boolean;
  requiresVerifiedToolResults: boolean;
  provider: RuntimeProvider;
  selectedModelLabel: string;
  selectedModelId: string;
  conversationMode: string;
  summary: string;
};

export type RuntimeConfigPayload = {
  runtime_provider: RuntimeProvider;
  auth_mode: AuthMode;
  provider_api_base_url: string;
  provider_api_key: string;
  default_model: string;
  workspace_root: string;
};

export type SessionCreateResponse = {
  ok?: boolean;
  session_id?: string;
  id?: string;
  session?: {
    id?: string;
    session_id?: string;
  };
  data?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
};

export type BridgeSessionRecord = {
  id?: string;
  status?: string;
  last_error?: string;
  assistant_draft?: string;
  assistantDraft?: string;
  pending_approval?: {
    request_id?: number | string;
    method?: string;
    title?: string;
    description?: string;
    preview?: string;
    payload?: Record<string, unknown>;
    created_at?: number;
  } | null;
  events?: Array<{
    type?: string;
    item?: {
      type?: string;
      text?: string;
    };
    text?: string;
    preview?: string;
  }>;
  messages?: Array<{
    role?: string;
    text?: string;
    thinking?: string;
  }>;
};

export type BridgeSessionResponse = {
  ok?: boolean;
  session?: BridgeSessionRecord;
  error?: string;
};

export type BridgeHealthResponse = {
  ok?: boolean;
  auth_state?: string;
  runtime_kind?: string;
  runtime_config?: {
    runtime_provider?: string;
    auth_mode?: string;
    provider_api_base_url?: string;
    default_model?: string;
    workspace_root?: string;
  };
  error?: string;
};

export type RequestJsonOptions = {
  suppressLog?: boolean;
  timeoutMs?: number;
};

export type BridgeProbeResult = {
  baseUrl: string;
  host: string;
  port: number;
  socketReachable: boolean;
  healthOk: boolean;
  healthError?: string;
};

export type OsirusModelOption = {
  id: string;
  label: string;
  kind: 'product' | 'provider';
  productId?: string;
  providerSettingId?: string;
  modelId?: string;
  modelSlug?: string;
  providerKey?: string;
  hasStream?: boolean;
  conversationMode?: 'voice' | 'chat' | 'search' | 'copilot' | 'agent';
  llmContent?: string;
  generationMode?: string;
  searchId?: string;
  recipients?: Array<Record<string, unknown>>;
};

export type OsirusChatHistoryMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  productId?: string;
  providerSettingId?: string;
  modelId?: string;
  modelSlug?: string;
};

export type OsirusChatSnapshot = {
  chatId: string;
  title: string;
  messages: OsirusChatHistoryMessage[];
};

export type WebviewAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  kind: 'image' | 'file';
};

export type LocalChatMessageRole = 'user' | 'assistant' | 'system';

export type LocalChatMessage = {
  id: string;
  role: LocalChatMessageRole;
  content: string;
  attachments?: WebviewAttachment[];
  thinking?: string;
  createdAt: number;
};

export type LocalChatThread = {
  id: string;
  provider: RuntimeProvider;
  title: string;
  summary: string;
  workspaceFingerprint: string;
  createdAt: number;
  updatedAt: number;
  sessionId?: string;
  osirusChatId?: string;
  selectedModelId?: string;
  messages: LocalChatMessage[];
};

export type ChatPanelThreadSummary = {
  id: string;
  title: string;
  summary: string;
  updatedAt: number;
  provider: RuntimeProvider;
  active: boolean;
};

export type OsirusMobileSignInResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
  active_org_id?: string | null;
  user?: {
    id?: string;
    email?: string;
    name?: string;
    first_name?: string;
    last_name?: string;
  };
};

export type OsirusMobileRefreshResponse = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_expires_in?: number;
};

export type OsirusDeviceAuthStartResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
};

export type OsirusDeviceAuthPollResponse = {
  status?: 'pending' | 'approved' | 'expired' | 'consumed';
  access_token?: string;
  refresh_token?: string;
  active_org_id?: string | null;
  active_org_name?: string | null;
};

export type OsirusOrgMembership = {
  id: string;
  orgId: string;
  role?: string;
  org?: {
    id: string;
    name?: string;
    slug?: string;
  } | null;
};

export type OsirusActiveOrgResponse = {
  org_id?: string | null;
  orgId?: string | null;
  access_token?: string;
  accessToken?: string;
  refresh_token?: string;
  refreshToken?: string;
};
