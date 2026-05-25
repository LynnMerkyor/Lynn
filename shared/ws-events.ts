type RequiredFieldMap<T extends string> = Readonly<Record<T, readonly string[]>>;

export type WsValidationResult = {
  ok: boolean;
  errors: string[];
};

export const CLIENT_EVENT_TYPES = Object.freeze([
  "abort",
  "compact",
  "context_usage",
  "prompt",
  "resume_stream",
  "steer",
  "toggle_plan_mode",
] as const);

export type ClientEventType = (typeof CLIENT_EVENT_TYPES)[number];

export const REACT_CHAT_EVENT_TYPES = Object.freeze([
  "artifact",
  "browser_screenshot",
  "compaction_end",
  "compaction_start",
  "cron_confirmation",
  "file_diff",
  "file_output",
  "mood_end",
  "mood_start",
  "mood_text",
  "model_hint",
  "provider_meta",
  "settings_confirmation",
  "skill_activated",
  "text_delta",
  "thinking_delta",
  "thinking_end",
  "thinking_start",
  "tool_authorization",
  "tool_end",
  "tool_progress",
  "tool_start",
  "turn_end",
  "xing_end",
  "xing_start",
  "xing_text",
] as const);

export type ReactChatEventType = (typeof REACT_CHAT_EVENT_TYPES)[number];

export const SERVER_EVENT_TYPES = Object.freeze([
  ...REACT_CHAT_EVENT_TYPES,
  "activity_update",
  "apply_frontend_setting",
  "bridge_message",
  "bridge_status",
  "browser_bg_status",
  "browser_status",
  "channel_archived",
  "channel_new_message",
  "confirmation_resolved",
  "context_usage",
  "desk_changed",
  "devlog",
  "dm_new_message",
  "error",
  "jian_update",
  "notification",
  "plan_mode",
  "prompt_accepted",
  "review_progress",
  "review_result",
  "review_start",
  "security_mode",
  "session_relay",
  "session_title",
  "status",
  "steered",
  "stream_resume",
  "task_update",
  "turn_retry",
] as const);

export type ServerEventType = (typeof SERVER_EVENT_TYPES)[number];

export const SERVER_EVENT_REQUIRED_FIELDS = Object.freeze({
  activity_update: ["activity"],
  apply_frontend_setting: ["key"],
  artifact: ["artifactId", "title", "content"],
  bridge_message: ["message"],
  bridge_status: ["platform", "status"],
  browser_bg_status: ["running"],
  browser_screenshot: ["base64", "mimeType"],
  browser_status: ["running"],
  channel_archived: ["channelName"],
  channel_new_message: ["channelName"],
  compaction_end: [],
  compaction_start: [],
  confirmation_resolved: ["confirmId", "action"],
  context_usage: [],
  cron_confirmation: ["jobData"],
  desk_changed: [],
  devlog: ["text"],
  dm_new_message: [],
  error: ["message"],
  file_diff: ["filePath", "diff"],
  file_output: ["filePath", "label", "ext"],
  jian_update: ["content"],
  model_hint: ["model"],
  mood_end: [],
  mood_start: [],
  mood_text: ["delta"],
  notification: ["title"],
  plan_mode: ["enabled"],
  prompt_accepted: ["sessionPath"],
  provider_meta: ["activeProvider"],
  review_progress: ["reviewId", "stage"],
  review_result: ["reviewId"],
  review_start: ["reviewId", "reviewerName"],
  security_mode: ["mode"],
  session_relay: ["newSessionPath"],
  session_title: ["title", "path"],
  settings_confirmation: ["confirmId", "settingKey"],
  skill_activated: ["skillName", "skillFilePath"],
  status: ["isStreaming"],
  steered: [],
  stream_resume: ["sessionPath", "sinceSeq", "nextSeq", "events"],
  task_update: ["task"],
  text_delta: ["delta"],
  thinking_delta: ["delta"],
  thinking_end: [],
  thinking_start: [],
  tool_authorization: ["confirmId", "command"],
  tool_end: ["name", "success"],
  tool_progress: ["event", "name"],
  tool_start: ["name"],
  turn_end: [],
  turn_retry: ["reason"],
  xing_end: [],
  xing_start: [],
  xing_text: ["delta"],
} as const satisfies RequiredFieldMap<ServerEventType>);

export const CLIENT_EVENT_REQUIRED_FIELDS = Object.freeze({
  abort: [],
  compact: [],
  context_usage: [],
  prompt: [],
  resume_stream: ["sessionPath", "sinceSeq"],
  steer: ["text"],
  toggle_plan_mode: [],
} as const satisfies RequiredFieldMap<ClientEventType>);

type EventPayload<
  TType extends string,
  TFields extends readonly string[],
> = {
  type: TType;
} & {
  [Field in TFields[number]]: unknown;
} & Record<string, unknown>;

export type ClientEvent = {
  [Type in ClientEventType]: EventPayload<Type, (typeof CLIENT_EVENT_REQUIRED_FIELDS)[Type]>;
}[ClientEventType];

export type ServerEvent = {
  [Type in ServerEventType]: EventPayload<Type, (typeof SERVER_EVENT_REQUIRED_FIELDS)[Type]>;
}[ServerEventType];

export type WsProtocolSnapshot = {
  clientEventTypes: readonly ClientEventType[];
  reactChatEventTypes: readonly ReactChatEventType[];
  serverEventTypes: readonly ServerEventType[];
  clientRequiredFields: typeof CLIENT_EVENT_REQUIRED_FIELDS;
  serverRequiredFields: typeof SERVER_EVENT_REQUIRED_FIELDS;
};

const serverTypeSet: ReadonlySet<string> = new Set(SERVER_EVENT_TYPES);
const clientTypeSet: ReadonlySet<string> = new Set(CLIENT_EVENT_TYPES);
const reactChatTypeSet: ReadonlySet<string> = new Set(REACT_CHAT_EVENT_TYPES);

function validateEvent(
  event: unknown,
  typeSet: ReadonlySet<string>,
  requiredFields: Readonly<Record<string, readonly string[]>>,
  label: string,
): WsValidationResult {
  if (!event || typeof event !== "object") {
    return { ok: false, errors: [`${label} event must be an object`] };
  }
  const candidate = event as Record<string, unknown>;
  if (typeof candidate.type !== "string" || !candidate.type) {
    return { ok: false, errors: [`${label} event type must be a non-empty string`] };
  }
  if (!typeSet.has(candidate.type)) {
    return { ok: false, errors: [`unknown ${label} event type: ${candidate.type}`] };
  }
  const missing = (requiredFields[candidate.type] || []).filter((field) => candidate[field] === undefined);
  if (missing.length) {
    return { ok: false, errors: [`${label} event ${candidate.type} missing required field(s): ${missing.join(", ")}`] };
  }
  return { ok: true, errors: [] };
}

export function isKnownServerEventType(type: unknown): type is ServerEventType {
  return typeof type === "string" && serverTypeSet.has(type);
}

export function isKnownClientEventType(type: unknown): type is ClientEventType {
  return typeof type === "string" && clientTypeSet.has(type);
}

export function isReactChatEventType(type: unknown): type is ReactChatEventType {
  return typeof type === "string" && reactChatTypeSet.has(type);
}

export function validateServerEvent(event: unknown): WsValidationResult {
  return validateEvent(event, serverTypeSet, SERVER_EVENT_REQUIRED_FIELDS, "server");
}

export function validateClientEvent(event: unknown): WsValidationResult {
  return validateEvent(event, clientTypeSet, CLIENT_EVENT_REQUIRED_FIELDS, "client");
}

export function createWsProtocolSnapshot(): WsProtocolSnapshot {
  return {
    clientEventTypes: [...CLIENT_EVENT_TYPES],
    reactChatEventTypes: [...REACT_CHAT_EVENT_TYPES],
    serverEventTypes: [...SERVER_EVENT_TYPES],
    clientRequiredFields: CLIENT_EVENT_REQUIRED_FIELDS,
    serverRequiredFields: SERVER_EVENT_REQUIRED_FIELDS,
  };
}
