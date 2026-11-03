import {
  Archive,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Code2,
  Command,
  FilePlus2,
  FileText,
  FolderInput,
  Globe,
  ImagePlus,
  GitBranch,
  Link2,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Search,
  Clock3,
  Settings,
  Shield,
  Square,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {MarkdownCodeBlock} from "./MarkdownCodeBlock";
import { RpcClient, type ConnectionState } from "./protocol";
import ScheduledTasks from "./ScheduledTasks";
import ThreadGoalPanel from "./ThreadGoalPanel";
import FileReferenceViewer from "./FileReferenceViewer";
import {clientUUID} from "./client-uuid";
import {codexThreadLink,forkAtMessage} from "./conversation-actions";
import CodexAccountPlugins from "./CodexAccountPlugins";
import { readInterfaceLanguage, setInterfaceLanguage, type InterfaceLanguage } from "./interface-language";
import ThreadPluginOptions from "./ThreadPluginOptions";
import SidebarQuota from "./SidebarQuota";
import type {
  ApprovalPrompt,
  DaemonStatus,
  ModelOption,
  QueuedSteerRecovery,
  QueuedSubmission,
  RpcError,
  ThreadDetails,
  ThreadItem,
  ThreadItemEntry,
  ThreadSummary,
  ScheduledTask,
  ThreadTokenUsage,
  McpServerElicitationResponse,
  UserInput,
} from "./types";
import { groupSidebarThreads, readProjectPreferences, projectPreferencesKey, subagentSourceKinds, agentAncestorIds, buildAgentTreeRows, agentDisplayName, buildProjectCreateParams, type CodexProject, type ProjectPreferences, type ProjectSort, type SidebarThreadGroup } from "./project-sidebar";
import { threadIndicator, activeSubagentParents, scheduledThreadIds } from "./thread-status";
import { readThreadStatusPreferences, threadStatusPreferencesKey, threadStatusOrder, threadStatusLabels, defaultThreadStatusPreferences } from "./thread-status-preferences";
import "./styles.css";

type FileReferenceContextValue={
  client:RpcClient|null;cwd:string;
  openThread:(threadId:string)=>void;
};
const FileReferenceContext=createContext<FileReferenceContextValue|null>(null);
type OptimisticSubmission = {
  id:string;
  threadId:string|null;
  kind:"turn"|"steer"|"queue";
  status:"sending"|"confirmed"|"unconfirmed";
  input:UserInput[];
  attachments:PendingUpload[];
  selectedSkills:SelectedSkillReference[];
  error?:string;
  turnId?:string;
};
type TimelineItem = ThreadItemEntry & { streaming?: boolean };
type TimelineGroup =
  | {
      kind: "message";
      key: string;
      entry: TimelineItem;
      responseKey: string | null;
    }
  | {
      kind: "activity";
      key: string;
      responseKey: string;
      defaultOwnerKey: string;
      entries: TimelineItem[];
    };
type ThreadTrailEntry = { id: string; title: string };
type ThreadContextMenu = {
  thread: ThreadSummary;
  left: number;
  top: number;
};
type ConversationRoute = { kind: "new" } | { kind: "thread"; threadId: string };
type ConversationHistoryState = {
  codexDeskRoute: true;
  routeHash: string;
  threadTrail: ThreadTrailEntry[];
  parentRoute?: string;
};
type PendingUpload = {
  id: string;
  name: string;
  dataUrl: string;
  size: number;
};
type ThemeChoice = "system" | "light" | "dark";
type PushSetupState =
  "loading" | "ready" | "denied" | "unsupported" | "unavailable" | "error";
type AppNotice = { tone: "info" | "error" | "success"; text: string };

type ComposerCompletionTarget = {
  kind: "command" | "file" | "skill" | "mention";
  start: number;
  end: number;
  query: string;
};
type ComposerCompletionItem =
  | {
      kind: "command";
      command: "/compact" | "/new";
      description: string;
      disabled?: boolean;
      disabledReason?: string;
    }
  | {
      kind: "file";
      path: string;
      label: string;
      isDirectory: boolean;
    }
  | {
      kind: "skill";
      name: string;
      description: string;
      path: string;
    }
  | {
      kind: "plugin";
      name: string;
      id: string;
      description: string;
    };
type SelectedSkillReference = { name: string; path: string };
type AgentIdentity = { glyph: string; color: number };
type FuzzyFileSearchResult = {
  path: string;
  root: string;
  file_name: string;
  match_type: "file" | "directory";
};
type SkillsListResponse = {
  data: Array<{
    cwd: string;
    skills: Array<{
      name: string;
      description: string;
      path: string;
      enabled: boolean;
    }>;
  }>;
};

type PushConfiguration = { ready: boolean; publicKey: string | null };
type McpElicitationChoice = { value: string; label: string };
type McpElicitationField = {
  id: string;
  label: string;
  description: string;
  required: boolean;
  kind: "string" | "number" | "boolean" | "single" | "multi";
  integer?: boolean;
  defaultValue?: string | number | boolean | string[];
  options?: McpElicitationChoice[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: "email" | "uri" | "date" | "date-time";
};
type McpElicitationFieldValue = string | boolean | string[] | null;

function parseMcpElicitationFields(
  schema: unknown,
): McpElicitationField[] | null {
  if (
    !isRecord(schema) ||
    schema.type !== "object" ||
    !isRecord(schema.properties)
  )
    return null;
  if (
    Object.keys(schema).some(
      (key) => !["$schema", "type", "properties", "required"].includes(key),
    ) ||
    (schema.$schema !== undefined && typeof schema.$schema !== "string")
  )
    return null;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    !required.every((field) => typeof field === "string")
  )
    return null;
  const propertyMap = schema.properties;
  const properties = Object.entries(propertyMap);
  if (required.some((field) => !(field in propertyMap))) return null;
  const fields: McpElicitationField[] = [];

  for (const [id, property] of properties) {
    if (!isRecord(property)) return null;
    const allowedKeys =
      property.enum !== undefined
        ? ["type", "title", "description", "enum", "enumNames", "default"]
        : Array.isArray(property.oneOf)
          ? ["type", "title", "description", "oneOf", "default"]
          : property.type === "string"
            ? [
                "type",
                "title",
                "description",
                "minLength",
                "maxLength",
                "format",
                "default",
              ]
            : property.type === "number" || property.type === "integer"
              ? [
                  "type",
                  "title",
                  "description",
                  "minimum",
                  "maximum",
                  "default",
                ]
              : property.type === "boolean"
                ? ["type", "title", "description", "default"]
                : property.type === "array"
                  ? [
                      "type",
                      "title",
                      "description",
                      "minItems",
                      "maxItems",
                      "items",
                      "default",
                    ]
                  : [];
    if (Object.keys(property).some((key) => !allowedKeys.includes(key)))
      return null;
    const field: McpElicitationField = {
      id,
      label: asString(property.title, id),
      description: asString(property.description),
      required: required.includes(id),
      kind: "string",
    };
    const setBound = (
      key:
        | "minimum"
        | "maximum"
        | "minLength"
        | "maxLength"
        | "minItems"
        | "maxItems",
    ) => {
      const value = property[key];
      if (value === undefined) return true;
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      if (
        (key === "minLength" ||
          key === "maxLength" ||
          key === "minItems" ||
          key === "maxItems") &&
        (!Number.isInteger(value) || value < 0)
      )
        return false;
      field[key] = value;
      return true;
    };
    const setDefault = (value: unknown) => {
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean" ||
        (Array.isArray(value) &&
          value.every((entry) => typeof entry === "string"))
      )
        field.defaultValue = value;
    };

    if (
      property.type === "string" &&
      property.enum === undefined &&
      !Array.isArray(property.oneOf)
    ) {
      field.kind = "string";
      if (
        !setBound("minLength") ||
        !setBound("maxLength") ||
        (property.minLength !== undefined &&
          property.maxLength !== undefined &&
          Number(property.minLength) > Number(property.maxLength))
      )
        return null;
      if (
        property.format !== undefined &&
        !["email", "uri", "date", "date-time"].includes(
          asString(property.format),
        )
      )
        return null;
      if (property.format)
        field.format = property.format as McpElicitationField["format"];
      if (typeof property.default === "string") setDefault(property.default);
    } else if (property.type === "number" || property.type === "integer") {
      field.kind = "number";
      field.integer = property.type === "integer";
      if (
        !setBound("minimum") ||
        !setBound("maximum") ||
        (property.minimum !== undefined &&
          property.maximum !== undefined &&
          Number(property.minimum) > Number(property.maximum))
      )
        return null;
      if (typeof property.default === "number") setDefault(property.default);
    } else if (property.type === "boolean") {
      field.kind = "boolean";
      if (typeof property.default === "boolean") setDefault(property.default);
    } else if (property.type === "array") {
      field.kind = "multi";
      if (!setBound("minItems") || !setBound("maxItems")) return null;
      const items = property.items;
      if (!isRecord(items)) return null;
      if (items.type === "string" && Array.isArray(items.enum)) {
        if (
          Object.keys(items).some((key) => !["type", "enum"].includes(key)) ||
          !items.enum.every((value) => typeof value === "string") ||
          new Set(items.enum).size !== items.enum.length
        )
          return null;
        field.options = items.enum.map((value) => ({
          value,
          label: value,
        }));
      } else if (Array.isArray(items.anyOf)) {
        if (Object.keys(items).some((key) => key !== "anyOf")) return null;
        const options = items.anyOf.map((option) =>
          isRecord(option) &&
          typeof option.const === "string" &&
          typeof option.title === "string"
            ? { value: option.const, label: option.title }
            : null,
        );
        if (
          options.some((option) => option === null) ||
          new Set(options.map((option) => option?.value)).size !==
            options.length
        )
          return null;
        field.options = options as McpElicitationChoice[];
      } else {
        return null;
      }
      if (
        field.minItems !== undefined &&
        field.maxItems !== undefined &&
        field.minItems > field.maxItems
      )
        return null;
      if (
        Array.isArray(property.default) &&
        property.default.every((value) =>
          field.options?.some((option) => option.value === value),
        )
      )
        setDefault(property.default);
    } else if (property.enum !== undefined) {
      field.kind = "single";
      if (
        !Array.isArray(property.enum) ||
        !property.enum.every((value) => typeof value === "string") ||
        new Set(property.enum).size !== property.enum.length
      )
        return null;
      if (
        property.enumNames !== undefined &&
        (!Array.isArray(property.enumNames) ||
          property.enumNames.length !== property.enum.length ||
          !property.enumNames.every((value) => typeof value === "string"))
      )
        return null;
      const enumNames = property.enumNames as string[] | undefined;
      field.options = property.enum.map((value, index) => ({
        value,
        label: asString(enumNames?.[index], value),
      }));
      if (
        typeof property.default === "string" &&
        field.options.some((option) => option.value === property.default)
      )
        setDefault(property.default);
    } else if (Array.isArray(property.oneOf)) {
      field.kind = "single";
      const options = property.oneOf.map((option) =>
        isRecord(option) &&
        typeof option.const === "string" &&
        typeof option.title === "string"
          ? { value: option.const, label: option.title }
          : null,
      );
      if (
        options.some((option) => option === null) ||
        new Set(options.map((option) => option?.value)).size !== options.length
      )
        return null;
      field.options = options as McpElicitationChoice[];
      if (
        typeof property.default === "string" &&
        field.options.some((option) => option.value === property.default)
      )
        setDefault(property.default);
    } else {
      return null;
    }
    if (
      field.minLength !== undefined &&
      field.maxLength !== undefined &&
      field.minLength > field.maxLength
    )
      return null;
    fields.push(field);
  }
  return fields;
}

function initialMcpElicitationValues(
  fields: McpElicitationField[],
): Record<string, McpElicitationFieldValue> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = field.defaultValue;
      if (value !== undefined) {
        if (Array.isArray(value)) return [field.id, [...value]];
        if (field.kind === "boolean") return [field.id, value === true];
        return [field.id, String(value)];
      }
      return [
        field.id,
        field.kind === "multi" ? [] : field.kind === "single" ? null : "",
      ];
    }),
  );
}

function isValidElicitationDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function validateMcpElicitationValues(
  fields: McpElicitationField[],
  values: Record<string, McpElicitationFieldValue>,
): { content?: Record<string, unknown>; error?: string } {
  const content: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const value = values[field.id];
    if (field.kind === "string") {
      const text = typeof value === "string" ? value : "";
      const length = Array.from(text).length;
      if (field.required && !text.trim())
        return { error: `${field.label} is required.` };
      if (text && field.minLength !== undefined && length < field.minLength)
        return {
          error: `${field.label} must have at least ${field.minLength} characters.`,
        };
      if (text && field.maxLength !== undefined && length > field.maxLength)
        return {
          error: `${field.label} must have at most ${field.maxLength} characters.`,
        };
      if (text && field.format === "email" && !/^\S+@\S+\.\S+$/.test(text))
        return { error: `${field.label} must be an email address.` };
      if (text && field.format === "uri") {
        try {
          if (!/^[a-z][a-z\d+.-]*:/i.test(text))
            return { error: `${field.label} must be a URI.` };
          new URL(text);
        } catch {
          return { error: `${field.label} must be a URI.` };
        }
      }
      if (text && field.format === "date") {
        if (!isValidElicitationDate(text))
          return {
            error: `${field.label} must be a valid date in YYYY-MM-DD format.`,
          };
      }
      if (
        text &&
        field.format === "date-time" &&
        (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(text) ||
          !isValidElicitationDate(text.slice(0, 10)) ||
          !Number.isFinite(Date.parse(text)))
      )
        return { error: `${field.label} must be an ISO date and time.` };
      if (text) content[field.id] = text;
      continue;
    }
    if (field.kind === "number") {
      const raw = typeof value === "string" ? value.trim() : "";
      if (!raw) {
        if (field.required) return { error: `${field.label} is required.` };
        continue;
      }
      const number = Number(raw);
      if (!Number.isFinite(number))
        return { error: `${field.label} must be a valid number.` };
      if (field.integer && !Number.isInteger(number))
        return { error: `${field.label} must be an integer.` };
      if (field.minimum !== undefined && number < field.minimum)
        return { error: `${field.label} must be at least ${field.minimum}.` };
      if (field.maximum !== undefined && number > field.maximum)
        return { error: `${field.label} must be at most ${field.maximum}.` };
      content[field.id] = number;
      continue;
    }
    if (field.kind === "boolean") {
      if (typeof value !== "boolean") {
        if (field.required) return { error: `${field.label} is required.` };
        continue;
      }
      content[field.id] = value;
      continue;
    }
    if (field.kind === "single") {
      const choice = typeof value === "string" ? value : "";
      if (typeof value !== "string") {
        if (field.required) return { error: `${field.label} is required.` };
        continue;
      }
      if (!field.options?.some((option) => option.value === choice))
        return { error: `Choose a valid option for ${field.label}.` };
      content[field.id] = choice;
      continue;
    }
    const choices = Array.isArray(value) ? value : [];
    if (field.required && choices.length === 0)
      return { error: `${field.label} is required.` };
    if (field.minItems !== undefined && choices.length < field.minItems)
      return {
        error: `Choose at least ${field.minItems} options for ${field.label}.`,
      };
    if (field.maxItems !== undefined && choices.length > field.maxItems)
      return {
        error: `Choose at most ${field.maxItems} options for ${field.label}.`,
      };
    if (
      choices.some(
        (choice) => !field.options?.some((option) => option.value === choice),
      )
    )
      return { error: `Choose valid options for ${field.label}.` };
    if (choices.length || field.required) content[field.id] = choices;
  }
  return { content };
}

function approvalSupportsPersist(meta: Record<string, unknown>, value: string) {
  const persist = meta.persist;
  return typeof persist === "string"
    ? persist === value
    : Array.isArray(persist) && persist.includes(value);
}

function safeElicitationUrl(value: unknown, serverName: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return null;
    if (serverName === "codex_apps") {
      const host = url.hostname.toLowerCase();
      if (
        host !== "chatgpt.com" &&
        host !== "chatgpt-staging.com" &&
        !host.endsWith(".chatgpt.com") &&
        !host.endsWith(".chatgpt-staging.com")
      )
        return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

const selectedThreadKey = "codex-desk.selected-thread";
const queuedSteerRecoveryKey = "codex-daemon-web.queued-steer-recovery";
const themeChoiceKey = "codex-daemon-web-theme";
const completionSoundKey = "codex-daemon-web-completion-sound";
const maxTurnRequestBytes = 900 * 1024;
const maxAttachmentBytes = 700 * 1024;
const maxCompressedImageBytes = 320 * 1024;
const maxImageFileBytes = 20 * 1024 * 1024;
const maxImageCount = 4;

function readQueuedSteerRecovery(): QueuedSteerRecovery | null {
  try {
    const value = JSON.parse(
      sessionStorage.getItem(queuedSteerRecoveryKey) ?? "null",
    );
    if (
      !isRecord(value) ||
      typeof value.threadId !== "string" ||
      !isRecord(value.submission) ||
      typeof value.submission.id !== "string" ||
      !Array.isArray(value.submission.input) ||
      typeof value.submission.clientUserMessageId !== "string" ||
      typeof value.originalPosition !== "number" ||
      !Array.isArray(value.originalQueueIds) ||
      !value.originalQueueIds.every((id) => typeof id === "string") ||
      !["removing", "steering", "unknown", "restoreFailed"].includes(
        asString(value.status),
      )
    )
      return null;
    return value as unknown as QueuedSteerRecovery;
  } catch {
    return null;
  }
}

async function listThreadQueue(
  rpc: Pick<RpcClient, "request">,
  threadId: string,
): Promise<QueuedSubmission[]> {
  const submissions: QueuedSubmission[] = [];
  let cursor: string | null = null;
  do {
    const page: {
      data: QueuedSubmission[];
      nextCursor: string | null;
    } = await rpc.request("thread/queue/list", {
      threadId,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    submissions.push(...page.data);
    if (!page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  } while (true);
  return [
    ...new Map(
      submissions.map((submission) => [submission.id, submission]),
    ).values(),
  ];
}

async function restoreQueuedSubmission(
  rpc: Pick<RpcClient, "request">,
  recovery: QueuedSteerRecovery,
  onAdded: (submission: QueuedSubmission) => void,
): Promise<{ submission: QueuedSubmission; positionRestored: boolean }> {
  let submissions = await listThreadQueue(rpc, recovery.threadId);
  let restored = submissions.find(
    (submission) =>
      submission.clientUserMessageId ===
      recovery.submission.clientUserMessageId,
  );
  if (!restored) {
    const result = await rpc.request<{ queuedSubmission: QueuedSubmission }>(
      "thread/queue/add",
      {
        threadId: recovery.threadId,
        input: recovery.submission.input,
        clientUserMessageId: recovery.submission.clientUserMessageId,
      },
    );
    if (!result.queuedSubmission?.id)
      throw new Error(
        "The daemon did not confirm that the message was restored.",
      );
    restored = result.queuedSubmission;
    onAdded(restored);
    submissions = await listThreadQueue(rpc, recovery.threadId);
  }

  const currentIds = submissions.map((submission) => submission.id);
  const withoutRestored = currentIds.filter((id) => id !== restored?.id);
  const originalBefore = recovery.originalQueueIds
    .slice(0, recovery.originalPosition)
    .filter((id) => withoutRestored.includes(id));
  const originalAfter = recovery.originalQueueIds
    .slice(recovery.originalPosition + 1)
    .filter((id) => withoutRestored.includes(id));
  const lastBefore = originalBefore.at(-1);
  const firstAfter = originalAfter[0];
  const insertAt = lastBefore
    ? withoutRestored.indexOf(lastBefore) + 1
    : firstAfter
      ? withoutRestored.indexOf(firstAfter)
      : Math.min(recovery.originalPosition, withoutRestored.length);
  const orderedIds = [
    ...withoutRestored.slice(0, insertAt),
    restored.id,
    ...withoutRestored.slice(insertAt),
  ];
  let positionRestored = true;
  try {
    if (orderedIds.some((id, index) => id !== currentIds[index]))
      await rpc.request("thread/queue/reorder", {
        threadId: recovery.threadId,
        queuedSubmissionIds: orderedIds,
      });
  } catch {
    positionRestored = false;
  }
  return { submission: restored, positionRestored };
}

async function threadHasClientMessage(
  rpc: RpcClient,
  threadId: string,
  clientUserMessageId: string,
  liveItems: TimelineItem[],
): Promise<boolean> {
  if (
    liveItems.some(
      (entry) =>
        entry.item.type === "userMessage" &&
        entry.item.clientId === clientUserMessageId,
    )
  )
    return true;
  const page = await rpc.request<{
    data: ThreadItemEntry[];
    nextCursor: string | null;
  }>("thread/items/list", {
    threadId,
    limit: 100,
    sortDirection: "desc",
  });
  return page.data.some(
    (entry) =>
      entry.item.type === "userMessage" &&
      entry.item.clientId === clientUserMessageId,
  );
}

function readThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(themeChoiceKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function readCompletionSoundPreference(): boolean {
  try {
    return localStorage.getItem(completionSoundKey) === "true";
  } catch {
    return false;
  }
}

function playCompletionTone(context: AudioContext): void {
  if (context.state !== "running") return;
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  const now = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(660, now);
  oscillator.frequency.setValueAtTime(880, now + 0.1);
  volume.gain.setValueAtTime(0.0001, now);
  volume.gain.exponentialRampToValueAtTime(0.045, now + 0.02);
  volume.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
  oscillator.connect(volume);
  volume.connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.3);
}

function supportsQuestionNotifications(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "Notification" in window &&
    "PushManager" in window &&
    "serviceWorker" in navigator
  );
}

async function loadPushConfiguration(): Promise<PushConfiguration> {
  const response = await fetch("/api/push/config", {
    credentials: "same-origin",
  });
  if (!response.ok) throw new Error("Could not load notification settings.");
  const result: unknown = await response.json();
  if (
    !isRecord(result) ||
    typeof result.enabled !== "boolean" ||
    (result.publicKey !== null && typeof result.publicKey !== "string")
  )
    throw new Error("Notification settings could not be read.");
  return { ready: result.enabled, publicKey: result.publicKey };
}

function decodePushApplicationServerKey(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value.replace(/-/g, "+").replace(/_/g, "/")}${padding}`;
  const binary = window.atob(base64);
  const key = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    key[index] = binary.charCodeAt(index);
  return key;
}

function pushSetupStateFor(configuration: PushConfiguration): PushSetupState {
  if (!configuration.ready || !configuration.publicKey) return "unavailable";
  return Notification.permission === "denied" ? "denied" : "ready";
}

async function getCurrentPushSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

async function savePushSubscription(
  subscription: PushSubscription,
): Promise<void> {
  const response = await fetch("/api/push/subscription", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (!response.ok)
    throw new Error("Could not save this device’s notification settings.");
}

function appAssetSignature(source: Document): string[] {
  const baseUrl = source.querySelector("base[href]")?.getAttribute("href");
  const base = baseUrl
    ? new URL(baseUrl, window.location.href)
    : window.location;
  return Array.from(
    source.querySelectorAll<HTMLElement>(
      'script[type="module"][src], link[rel="stylesheet"][href], link[rel="modulepreload"][href]',
    ),
  )
    .flatMap((element) => {
      const assetPath =
        element.getAttribute("src") ?? element.getAttribute("href");
      if (!assetPath) return [];
      const assetUrl = new URL(assetPath, base.href);
      if (assetUrl.origin !== window.location.origin) return [];
      return [`${element.tagName.toLowerCase()}:${assetUrl.pathname}`];
    })
    .sort();
}

function routeHash(route: ConversationRoute): string {
  return route.kind === "new"
    ? "#/new"
    : `#/thread/${encodeURIComponent(route.threadId)}`;
}

function parseRouteHash(hash: string): {
  route: ConversationRoute | null;
  invalid: boolean;
} {
  if (!hash) return { route: null, invalid: false };
  if (hash === "#/new") return { route: { kind: "new" }, invalid: false };
  const prefix = "#/thread/";
  if (!hash.startsWith(prefix)) return { route: null, invalid: true };
  const encodedId = hash.slice(prefix.length);
  if (!encodedId || encodedId.includes("/"))
    return { route: null, invalid: true };
  try {
    const threadId = decodeURIComponent(encodedId);
    if (!threadId || /[\u0000-\u001f\u007f]/.test(threadId))
      return { route: null, invalid: true };
    return { route: { kind: "thread", threadId }, invalid: false };
  } catch {
    return { route: null, invalid: true };
  }
}

function historyStateFor(
  route: ConversationRoute,
  threadTrail: ThreadTrailEntry[],
  parentRoute?: string,
): ConversationHistoryState {
  return {
    codexDeskRoute: true,
    routeHash: routeHash(route),
    threadTrail,
    ...(parentRoute ? { parentRoute } : {}),
  };
}

function writeHistoryRoute(
  route: ConversationRoute,
  threadTrail: ThreadTrailEntry[],
  mode: "push" | "replace",
  parentRoute?: string,
): void {
  const hash = routeHash(route);
  const url = `${window.location.pathname}${window.location.search}${hash}`;
  const state = historyStateFor(route, threadTrail, parentRoute);
  if (mode === "push" && window.location.hash !== hash)
    window.history.pushState(state, "", url);
  else window.history.replaceState(state, "", url);
}

function readHistoryState(
  value: unknown,
  expectedHash: string,
): ConversationHistoryState | null {
  const expectedRoute = parseRouteHash(expectedHash);
  if (
    !isRecord(value) ||
    value.codexDeskRoute !== true ||
    value.routeHash !== expectedHash ||
    !expectedRoute.route
  )
    return null;
  const threadTrail = Array.isArray(value.threadTrail)
    ? value.threadTrail.filter(
        (entry): entry is ThreadTrailEntry =>
          isRecord(entry) &&
          typeof entry.id === "string" &&
          Boolean(entry.id) &&
          typeof entry.title === "string",
      )
    : [];
  const parsedParent =
    typeof value.parentRoute === "string"
      ? parseRouteHash(value.parentRoute)
      : null;
  const parentRoute =
    parsedParent?.route?.kind === "thread"
      ? routeHash(parsedParent.route)
      : undefined;
  return {
    codexDeskRoute: true,
    routeHash: expectedHash,
    threadTrail,
    ...(parentRoute ? { parentRoute } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function ContextUsageIndicator({ usage }: { usage: ThreadTokenUsage | null }) {
  const [open, setOpen] = useState(false);
  const used = usage?.last.totalTokens;
  const limit = usage?.modelContextWindow;
  const known =
    typeof used === "number" &&
    Number.isFinite(used) &&
    used >= 0 &&
    typeof limit === "number" &&
    Number.isFinite(limit) &&
    limit > 0;
  const usedPercent = known ? (used / limit) * 100 : null;
  const arcPercent = usedPercent === null ? 0 : Math.min(100, usedPercent);
  const remainingPercent =
    usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const roundedPercent = usedPercent === null ? null : Math.round(usedPercent);
  const tone =
    usedPercent === null
      ? "unknown"
      : usedPercent >= 100
        ? "full"
        : usedPercent >= 85
          ? "warning"
          : "normal";
  const formatTokens = (value: number) => new Intl.NumberFormat().format(value);
  const details =
    known && usedPercent !== null && remainingPercent !== null
      ? `Context: ${formatTokens(used)} of ${formatTokens(limit)} tokens used; ${usedPercent.toFixed(1)}% used; ${remainingPercent!.toFixed(1)}% remaining.`
      : "Context usage is unavailable from Codex.";
  const label =
    roundedPercent === null
      ? "Context usage unavailable"
      : `Context usage ${roundedPercent}%`;
  const circumference = 2 * Math.PI * 8;

  return (
    <span className={`context-usage-wrap ${open ? "is-open" : ""}`}>
      <button
        type="button"
        className={`context-usage-button ${tone}`}
        aria-label={label}
        aria-expanded={open}
        aria-describedby="context-usage-details"
        onClick={() => setOpen((current) => !current)}
        onBlur={() => setOpen(false)}
      >
        <svg aria-hidden="true" viewBox="0 0 20 20">
          <circle className="context-usage-track" cx="10" cy="10" r="8" />
          {known ? (
            <circle
              className="context-usage-arc"
              cx="10"
              cy="10"
              r="8"
              transform="rotate(-90 10 10)"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - arcPercent / 100)}
            />
          ) : null}
        </svg>
        <span>{roundedPercent === null ? "?" : `${roundedPercent}%`}</span>
        <span className="context-usage-name">Context</span>
      </button>
      <span
        className="context-usage-tooltip"
        id="context-usage-details"
        role="tooltip"
      >
        {details}
      </span>
    </span>
  );
}

function QueuedMessageCard({
  submission,
  positionLabel,
  recovery = false,
  steerDisabled,
  steerLabel,
  steerReason,
  recoveryNote,
  onSteer,
  children,
}: {
  submission: QueuedSubmission;
  positionLabel?: string;
  recovery?: boolean;
  steerDisabled?: boolean;
  steerLabel?: string;
  steerReason?: string;
  recoveryNote?: string;
  onSteer?: () => void;
  children?: ReactNode;
}) {
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const text = submission.input
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => (isRecord(part) ? asString(part.text).trim() : ""))
    .filter(Boolean)
    .join(" ");
  const imageParts = submission.input.filter(
    (part) => isRecord(part) && part.type === "image",
  );
  const otherAttachments = submission.input.filter(
    (part) => isRecord(part) && part.type !== "text" && part.type !== "image",
  );
  const imagePreviews = imageParts
    .slice(0, 4)
    .map((part) => ("url" in part ? safeImageUrl(part.url) : null));
  const attachmentLabels = [
    ...imageParts.map(() => "Image"),
    ...otherAttachments.map((part) =>
      isRecord(part) && part.type === "skill"
        ? `Skill · ${asString(part.name)}`
        : isRecord(part) && part.type === "mention"
          ? `Mention · ${asString(part.name)}`
          : isRecord(part) && part.type === "localImage"
            ? "Image"
            : isRecord(part) &&
                (part.type === "audio" || part.type === "localAudio")
              ? "Audio"
              : "Attachment",
    ),
  ];
  const preview =
    [text, ...attachmentLabels].filter(Boolean).join(" · ") || "Queued message";

  return (
    <article
      className={`queued-message-card ${recovery ? "recovery" : ""} ${previewExpanded ? "preview-expanded" : ""}`}
    >
      {positionLabel ? (
        <div className="queued-message-order">{positionLabel}</div>
      ) : null}
      <div className="queued-message-content">
        {recovery ? (
          <>
            {text ? <p>{text}</p> : null}
            {imageParts.length ? (
              <div className="queued-message-attachments">
                {imagePreviews.map((url, index) =>
                  url ? (
                    <img
                      className="queued-message-image"
                      key={`${submission.id}-image-${index}`}
                      src={url}
                      alt="Queued image attachment"
                    />
                  ) : (
                    <span
                      className="queued-message-attachment"
                      key={`${submission.id}-image-${index}`}
                    >
                      Image attachment
                    </span>
                  ),
                )}
                {imageParts.length > imagePreviews.length ? (
                  <span className="queued-message-attachment">
                    +{imageParts.length - imagePreviews.length} images
                  </span>
                ) : null}
              </div>
            ) : null}
            {otherAttachments.length ? (
              <div className="queued-message-attachments">
                {otherAttachments.map((part, index) => (
                  <span
                    className="queued-message-attachment"
                    key={`${submission.id}-attachment-${index}`}
                  >
                    {isRecord(part) && part.type === "localImage"
                      ? "Image attachment"
                      : isRecord(part) &&
                          (part.type === "audio" || part.type === "localAudio")
                        ? "Audio attachment"
                        : isRecord(part) && part.type === "skill"
                          ? `Skill · ${asString(part.name)}`
                          : isRecord(part) && part.type === "mention"
                            ? `Mention · ${asString(part.name)}`
                            : "Attachment"}
                  </span>
                ))}
              </div>
            ) : null}
            {!text && !imageParts.length && !otherAttachments.length ? (
              <p>Queued message</p>
            ) : null}
          </>
        ) : (
          <button
            type="button"
            className="queued-message-preview"
            aria-expanded={previewExpanded}
            aria-controls={`queued-message-details-${submission.id}`}
            title={preview}
            onClick={() => setPreviewExpanded((current) => !current)}
          >
            <span className="queued-message-preview-text">
              {text || "Queued message"}
            </span>
            {attachmentLabels.length ? (
              <span className="queued-message-preview-attachments">
                {attachmentLabels.join(" · ")}
              </span>
            ) : null}
          </button>
        )}
        {!recovery ? (
          <div
            id={`queued-message-details-${submission.id}`}
            className="queued-message-preview-details"
            aria-hidden={!previewExpanded}
          >
            {text ? <p>{text}</p> : null}
            {imageParts.length ? (
              <div className="queued-message-preview-images">
                {imagePreviews.map((url, index) =>
                  url ? (
                    <img
                      key={`${submission.id}-preview-image-${index}`}
                      src={url}
                      alt={`Queued image ${index + 1}`}
                    />
                  ) : (
                    <span
                      className="queued-message-attachment"
                      key={`${submission.id}-preview-image-${index}`}
                    >
                      Image attachment
                    </span>
                  ),
                )}
                {imageParts.length > imagePreviews.length ? (
                  <span className="queued-message-attachment">
                    +{imageParts.length - imagePreviews.length} images
                  </span>
                ) : null}
              </div>
            ) : null}
            {otherAttachments.length ? (
              <div className="queued-message-preview-labels">
                {attachmentLabels
                  .slice(imageParts.length)
                  .map((label, index) => (
                    <span
                      className="queued-message-attachment"
                      key={`${submission.id}-preview-attachment-${index}`}
                    >
                      {label}
                    </span>
                  ))}
              </div>
            ) : null}
            {!text && !imageParts.length && !otherAttachments.length ? (
              <p>Queued message</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {recoveryNote ? (
        <p className="queued-message-recovery-note">{recoveryNote}</p>
      ) : null}
      {onSteer || children ? (
        <div className="queued-message-card-actions">
          {children}
          {onSteer ? (
            <button
              type="button"
              className="queued-message-steer"
              disabled={steerDisabled}
              title={
                steerDisabled ? steerReason : "Steer this queued message now"
              }
              aria-label={
                steerDisabled && steerReason
                  ? `Steer now unavailable. ${steerReason}`
                  : "Steer now"
              }
              aria-describedby={
                steerDisabled ? "queue-steer-unavailable-reason" : undefined
              }
              onClick={onSteer}
            >
              {steerLabel ?? "Steer"}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function QueuedMessageStack({
  submissions,
  expanded,
  onToggle,
  onRetry,
  loading,
  error,
  canSteer,
  steeringSubmissionId,
  steerUnavailableReason,
  onSteer,
  recovery,
  onCheckRecovery,
  onRestoreRecovery,
  recoveryBusy,
}: {
  submissions: QueuedSubmission[];
  expanded: boolean;
  onToggle: () => void;
  onRetry: () => void;
  loading: boolean;
  error: string;
  canSteer: boolean;
  steeringSubmissionId: string | null;
  steerUnavailableReason: string;
  onSteer: (submission: QueuedSubmission) => void;
  recovery: QueuedSteerRecovery | null;
  onCheckRecovery: () => void;
  onRestoreRecovery: (allowUnknown?: boolean) => void;
  recoveryBusy: boolean;
}) {
  if (loading && !submissions.length && !recovery)
    return (
      <div className="queued-message-state" role="status">
        Checking queued messages…
      </div>
    );
  if (error && !submissions.length && !recovery)
    return (
      <div className="queued-message-state error" role="status">
        <span>Queued messages could not be loaded.</span>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  if (!submissions.length && !recovery) return null;

  const visibleSubmissions = expanded ? submissions : submissions.slice(0, 1);
  const stacked = !expanded && submissions.length > 1;
  const recoveryUnknown =
    recovery?.status === "unknown" ||
    recovery?.status === "steering" ||
    recovery?.status === "removing";
  const recoveryMessage = recoveryUnknown
    ? "Queue state is uncertain. Check the conversation before restoring; the message may already have started."
    : recovery?.status === "restoreFailed"
      ? "The message could not be fully restored. Its saved input is kept here."
      : "The saved message was removed from the queue. Check its status before taking another action.";
  const hiddenRecoveryId =
    recovery?.restoredSubmissionId ?? recovery?.submission.id;
  const shownSubmissions = visibleSubmissions.filter(
    (submission) => submission.id !== hiddenRecoveryId,
  );

  return (
    <section
      className="queued-message-stack"
      aria-label={`${submissions.length} queued messages${recovery ? " and queue recovery" : ""}`}
    >
      <div
        className={`queued-message-cards ${stacked ? "stacked" : ""} ${expanded ? "expanded" : ""}`}
      >
        {shownSubmissions.map((submission, position) => (
          <QueuedMessageCard
            key={submission.id}
            submission={submission}
            steerDisabled={
              !canSteer || steeringSubmissionId !== null || Boolean(recovery)
            }
            steerLabel={
              steeringSubmissionId === submission.id ? "Working…" : "Steer"
            }
            steerReason={steerUnavailableReason}
            onSteer={() => onSteer(submission)}
            children={
              position === 0 && submissions.length > 1 ? (
                <button
                  type="button"
                  className="queued-message-expand"
                  aria-expanded={expanded}
                  title={
                    expanded
                      ? "Show fewer queued messages"
                      : `Show ${submissions.length - 1} more queued messages`
                  }
                  onClick={onToggle}
                >
                  {expanded ? "Less" : `+${submissions.length - 1}`}
                </button>
              ) : undefined
            }
          />
        ))}
      </div>
      {recovery ? (
        <div className="queued-message-recovery">
          <QueuedMessageCard
            key={`recovery-${recovery.submission.id}`}
            submission={recovery.submission}
            positionLabel="Saved for recovery"
            recovery
            recoveryNote={recoveryMessage}
          >
            {recovery.status === "restoreFailed" ? (
              <button
                type="button"
                disabled={recoveryBusy}
                onClick={() => onRestoreRecovery(false)}
              >
                Retry restore
              </button>
            ) : (
              <button
                type="button"
                disabled={recoveryBusy}
                onClick={onCheckRecovery}
              >
                Check status
              </button>
            )}
            {recoveryUnknown ? (
              <button
                type="button"
                disabled={recoveryBusy}
                onClick={() => onRestoreRecovery(true)}
              >
                Restore anyway
              </button>
            ) : null}
          </QueuedMessageCard>
        </div>
      ) : null}
      {submissions.length && !canSteer ? (
        <div
          id="queue-steer-unavailable-reason"
          className="queued-message-refresh-error"
          role="status"
        >
          {steerUnavailableReason}
        </div>
      ) : null}
      {error ? (
        <div className="queued-message-refresh-error" role="status">
          The queue may be out of date.
        </div>
      ) : null}
    </section>
  );
}

function userInputFromDraft(
  text: string,
  uploads: PendingUpload[],
  selectedSkills: SelectedSkillReference[],
): UserInput[] {
  const input: UserInput[] = [];
  if (text.trim())
    input.push({ type: "text", text: text.trim(), text_elements: [] });
  const uniqueSkills = new Map<string, SelectedSkillReference>();
  for (const skill of selectedSkills) {
    if (containsComposerToken(text, `$${skill.name}`))
      uniqueSkills.set(skill.path, skill);
  }
  for (const skill of uniqueSkills.values())
    input.push({ type: "skill", name: skill.name, path: skill.path });
  for (const upload of uploads)
    input.push({ type: "image", url: upload.dataUrl, detail: "auto" });
  return input;
}

function completionTargetAt(
  text: string,
  caret: number,
): ComposerCompletionTarget | null {
  const prefix = text.slice(0, caret);
  const commandMatch = /^(\s*)\/([^\s]*)$/.exec(prefix);
  if (commandMatch) {
    const following = /^[^\s]*/.exec(text.slice(caret))?.[0] ?? "";
    return {
      kind: "command",
      start: commandMatch[1].length,
      end: caret + following.length,
      query: commandMatch[2],
    };
  }
  const match = /(^|[\s([{])([@$])([^\s@$]*)$/.exec(prefix);
  if (!match) return null;
  const start = caret - match[2].length - match[3].length;
  const remaining = text.slice(caret);
  const following = /^[^\s@$]*/.exec(remaining)?.[0] ?? "";
  return {
    kind: match[2] === "@" ? "mention" : "skill",
    start,
    end: caret + following.length,
    query: match[3],
  };
}

const composerCommands: Array<{
  command: "/new" | "/compact";
  description: string;
}> = [
  { command: "/new", description: "Start a new conversation" },
  { command: "/compact", description: "Summarize this conversation" },
];

function isComposerCommandWithArguments(text: string): boolean {
  return /^\/(?:new|compact)\s+\S/u.test(text.trim());
}

const agentIdentityGlyphs = ["✺", "✿", "⚙", "✣", "✦", "❖"];

function agentIdentityFor(threadId: string, fallback: string): AgentIdentity {
  const identity = threadId.trim() || fallback.trim() || "agent";
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const value = hash >>> 0;
  return {
    glyph: agentIdentityGlyphs[value % agentIdentityGlyphs.length],
    color: (value >>> 4) % 8,
  };
}

function AgentIdentityMark({
  threadId,
  fallback,
  className = "",
}: {
  threadId: string;
  fallback: string;
  className?: string;
}) {
  const identity = agentIdentityFor(threadId, fallback);
  return (
    <span
      className={`agent-identity agent-identity-color-${identity.color} ${className}`.trim()}
      aria-hidden="true"
    >
      {identity.glyph}
    </span>
  );
}

function containsComposerToken(text: string, token: string): boolean {
  let offset = text.indexOf(token);
  while (offset >= 0) {
    const before = text[offset - 1];
    const after = text[offset + token.length];
    if (
      (!before || !/[\p{L}\p{N}_-]/u.test(before)) &&
      (!after || !/[\p{L}\p{N}_-]/u.test(after))
    )
      return true;
    offset = text.indexOf(token, offset + 1);
  }
  return false;
}

function imagesFromClipboard(data: DataTransfer): {
  containsImage: boolean;
  files: File[];
} {
  const items = Array.from(data.items).filter(
    (item) => item.kind === "file" && item.type.startsWith("image/"),
  );
  const itemFiles = items.flatMap((item) => {
    const file = item.getAsFile();
    return file ? [file] : [];
  });
  const fileListImages = Array.from(data.files).filter((file) =>
    file.type.startsWith("image/"),
  );
  const sameClipboardFile = (left: File, right: File) =>
    left.type === right.type &&
    left.size === right.size &&
    left.lastModified === right.lastModified;
  const matchedItemFiles = new Set<number>();
  const additionalFiles = fileListImages.filter((file) => {
    const matchingIndex = itemFiles.findIndex(
      (itemFile, index) =>
        !matchedItemFiles.has(index) && sameClipboardFile(file, itemFile),
    );
    if (matchingIndex === -1) return true;
    matchedItemFiles.add(matchingIndex);
    return false;
  });

  return {
    containsImage: items.length > 0 || fileListImages.length > 0,
    files: [...itemFiles, ...additionalFiles],
  };
}

function textFromClipboardWithImages(data: DataTransfer): string {
  let text = data.getData("text/plain");
  if (!text) {
    const html = data.getData("text/html");
    if (html) {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      parsed
        .querySelectorAll("script, style")
        .forEach((element) => element.remove());
      text = parsed.body.innerText || parsed.body.textContent || "";
    }
  }
  return text.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\r\n]+/gi, "");
}

function shortError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Could not read the compressed image."));
    reader.onerror = () =>
      reject(new Error("Could not read the compressed image."));
    reader.readAsDataURL(blob);
  });
}

function canvasToJpeg(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Could not compress this image.")),
      "image/jpeg",
      quality,
    );
  });
}

async function compressImage(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const maxDimension = 2048;
    let scale = Math.min(
      1,
      maxDimension / Math.max(bitmap.width, bitmap.height),
    );
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image compression is unavailable.");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const quality = Math.max(0.3, 0.86 - (attempt % 5) * 0.12);
      const blob = await canvasToJpeg(canvas, quality);
      const dataUrl = await blobToDataUrl(blob);
      if (
        new TextEncoder().encode(dataUrl).byteLength <= maxCompressedImageBytes
      )
        return dataUrl;
      if (attempt % 5 === 4) scale *= 0.78;
    }
    throw new Error(
      `${file.name} could not be compressed under the image limit.`,
    );
  } finally {
    bitmap.close();
  }
}

function serializedRequestBytes(
  method: string,
  params: Record<string, unknown>,
) {
  const request = JSON.stringify({
    id: Number.MAX_SAFE_INTEGER,
    method,
    params,
  });
  return new TextEncoder().encode(request).byteLength;
}

function safeImageUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(value)) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function titleFor(thread: ThreadSummary): string {
  return (
    thread.name?.trim() ||
    thread.preview?.trim().split("\n")[0] ||
    "New conversation"
  );
}

function threadActivityTimestamp(
  thread: ThreadSummary,
  archived: boolean,
): number | null {
  const timestamp = archived ? thread.updatedAt : thread.recencyAt;
  if (timestamp === null || !Number.isFinite(timestamp) || timestamp <= 0)
    return null;
  return timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
}

function formatThreadActivityTime(timestamp: number | null): string {
  if (timestamp === null) return "";
  const time = timestamp;
  const elapsed = Math.max(0, Date.now() - time);
  if (elapsed < 60_000) return "now";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 24 * 60 * 60_000)
    return `${Math.floor(elapsed / (60 * 60_000))}h`;
  if (elapsed < 7 * 24 * 60 * 60_000)
    return `${Math.floor(elapsed / (24 * 60 * 60_000))}d`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(time);
}

function projectNameFor(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
}

function sortThreadsByRecency(threads: ThreadSummary[]): ThreadSummary[] {
  return [...threads].sort((left, right) => {
    if (left.recencyAt === null && right.recencyAt !== null) return 1;
    if (left.recencyAt !== null && right.recencyAt === null) return -1;
    if (
      left.recencyAt !== null &&
      right.recencyAt !== null &&
      left.recencyAt !== right.recencyAt
    )
      return right.recencyAt - left.recencyAt;
    if (left.createdAt !== right.createdAt)
      return right.createdAt - left.createdAt;
    return left.id.localeCompare(right.id);
  });
}

function mergeThreadPage(
  current: ThreadSummary[],
  incoming: ThreadSummary[],
  append: boolean,
  sortByRecency: boolean,
): ThreadSummary[] {
  const merged = new Map(
    append ? current.map((thread) => [thread.id, thread]) : [],
  );
  for (const thread of incoming) {
    const existing = merged.get(thread.id);
    if (
      sortByRecency &&
      existing?.recencyAt !== null &&
      existing?.recencyAt !== undefined &&
      (thread.recencyAt === null || thread.recencyAt < existing.recencyAt)
    )
      continue;
    merged.set(thread.id, thread);
  }
  const unique = Array.from(merged.values());
  return sortByRecency ? sortThreadsByRecency(unique) : unique;
}

function statusLabel(state: ConnectionState): string {
  if (state === "online") return "Connected";
  if (state === "offline") return "Offline";
  if (state === "connecting") return "Connecting";
  return "Reconnecting";
}

function describeApproval(value: unknown): string {
  if (typeof value === "string") {
    if (value === "on-request") return "On request";
    if (value === "untrusted") return "Untrusted";
    if (value === "never") return "Never";
    return value;
  }
  if (isRecord(value) && isRecord(value.granular)) {
    const policy = value.granular;
    const enabled = [
      ["sandbox_approval", "sandbox"],
      ["rules", "rules"],
      ["skill_approval", "skills"],
      ["request_permissions", "permissions"],
      ["mcp_elicitations", "MCP prompts"],
    ] as const;
    const active = enabled
      .filter(([key]) => policy[key] === true)
      .map(([, label]) => label);
    const inactive = enabled
      .filter(([key]) => policy[key] === false)
      .map(([, label]) => label);
    return `Granular · on: ${active.join(", ") || "none"} · off: ${inactive.join(", ") || "none"}`;
  }
  return "Daemon default";
}

function describeSandbox(value: unknown): string {
  if (!isRecord(value) || typeof value.type !== "string")
    return "Daemon default";
  if (value.type === "dangerFullAccess") return "Full access";
  if (value.type === "readOnly") {
    return `Read only · network ${value.networkAccess ? "on" : "off"}`;
  }
  if (value.type === "workspaceWrite") {
    const roots = Array.isArray(value.writableRoots)
      ? value.writableRoots.filter(
          (root): root is string => typeof root === "string",
        )
      : [];
    return `Workspace write · network ${value.networkAccess ? "on" : "off"} · ${roots.join(", ") || "no writable roots"}`;
  }
  if (value.type === "externalSandbox") return "External sandbox";
  return value.type;
}

function useRpc() {
  const clientRef = useRef<RpcClient | null>(null);
  const [client, setClient] = useState<RpcClient | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("offline");
  const [connectionMessage, setConnectionMessage] = useState("");

  const attach = useCallback(
    (handlers: {
      onNotification: (method: string, params: Record<string, unknown>) => void;
      onServerRequest: (request: ApprovalPrompt) => void;
      onDisconnected: () => void;
      onReady: (rpc: RpcClient) => void;
    }) => {
      clientRef.current?.close();
      let instance: RpcClient;
      instance = new RpcClient({
        onState: (state, message) => {
          setConnection(state);
          setConnectionMessage(message ?? "");
        },
        onDisconnected: handlers.onDisconnected,
        onNotification: handlers.onNotification,
        onServerRequest: handlers.onServerRequest,
        onReady: () => handlers.onReady(instance),
      });
      clientRef.current = instance;
      setClient(instance);
      return instance;
    },
    [],
  );

  const detach = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
    setClient(null);
    setConnection("offline");
    setConnectionMessage("");
  }, []);

  useEffect(() => detach, [detach]);
  return { client, connection, connectionMessage, attach, detach };
}

export default function App() {
  if (window.location.pathname === "/browser") return <BrowserSurface />;
  return <WorkspaceApp />;
}

function WorkspaceApp() {
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(readThemeChoice);
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [token, setToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const noticeThreadIdRef = useRef<string | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [subagentThreads, setSubagentThreads] = useState<ThreadSummary[]>([]);
  const [codexProjects, setCodexProjects] = useState<CodexProject[]>([]);
  // Official Codex project ID for a *new* conversation. Never inferred from cwd.
  const [newProjectId,setNewProjectId] = useState("");
  const selectNewProject=(projectId:string)=>{
    setNewProjectId(projectId);
    if(!projectId)return;
    const project=codexProjects.find(entry=>entry.id===projectId);
    const roots=project?.roots.map(entry=>entry.path).filter(Boolean)||[];
    if(roots.length && !roots.some(root=>cwd===root||cwd.startsWith(root+"/")))
      setCwd(roots[0]);
  };
  const projectOptionLabel=(project:CodexProject)=>
    project.name+" · "+(project.roots[0]?.path||project.id);

  const [projectRenameId, setProjectRenameId] = useState<string|null>(null);
  const [projectRenameValue, setProjectRenameValue] = useState("");
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectCreateName, setProjectCreateName] = useState("");
  const [projectCreateRoot, setProjectCreateRoot] = useState("");
  const [projectCreateIdempotencyKey, setProjectCreateIdempotencyKey] = useState("");
  const [projectMoveThread, setProjectMoveThread] = useState<ThreadSummary|null>(null);
  const [archiveConfirmThread,setArchiveConfirmThread]=useState<ThreadSummary|null>(null);
  const [archiveMutationBusy,setArchiveMutationBusy]=useState(false);
  const [projectMoveTarget, setProjectMoveTarget] = useState("");
  const [projectMutationBusy, setProjectMutationBusy] = useState(false);

  const [scheduledTasksForIndicators, setScheduledTasksForIndicators] = useState<ScheduledTask[]>([]);
  const [failedThreadIds, setFailedThreadIds] = useState<Set<string>>(() => new Set());
  const [threadStatusPreferences, setThreadStatusPreferences] = useState(() => {
    try { return readThreadStatusPreferences(localStorage); }
    catch { return readThreadStatusPreferences({getItem: () => null}); }
  });
  useEffect(() => {
    try { localStorage.setItem(threadStatusPreferencesKey, JSON.stringify(threadStatusPreferences)); }
    catch { /* Device preference storage may be unavailable. */ }
  }, [threadStatusPreferences]);

  const [collapsedSubagents, setCollapsedSubagents] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem("codex-web.subagent-tree.v1") || "{}"); }
    catch { return {}; }
  });
  useEffect(() => {
    try { localStorage.setItem("codex-web.subagent-tree.v1", JSON.stringify(collapsedSubagents)); }
    catch { /* Local storage may be unavailable. */ }
  }, [collapsedSubagents]);

  const threadsRef = useRef<ThreadSummary[]>([]);
  const [archivedThreads, setArchivedThreads] = useState(false);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [threadSearch, setThreadSearch] = useState("");
  const [projectPreferences, setProjectPreferences] = useState<ProjectPreferences>(() => {
    try { return readProjectPreferences(localStorage); }
    catch { return { collapsed: {}, sort: "recent", view: "projects" }; }
  });
  useEffect(() => {
    try { localStorage.setItem(projectPreferencesKey, JSON.stringify(projectPreferences)); }
    catch { /* Keep the sidebar usable when browser storage is unavailable. */ }
  }, [projectPreferences]);
  const [sidebarSearchOpen, setSidebarSearchOpen] = useState(false);
  const [sidebarSection, setSidebarSection] = useState<"chats" | "tasks">(
    "chats",
  );
  const [scheduleCount, setScheduleCount] = useState(0);
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(
    null,
  );
  const [queuedSubmissions, setQueuedSubmissions] = useState<
    QueuedSubmission[]
  >([]);
  const [queueThreadId, setQueueThreadId] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [queueExpanded, setQueueExpanded] = useState(false);
  const [steeringSubmissionId, setSteeringSubmissionId] = useState<
    string | null
  >(null);
  const queueSteerInFlightRef = useRef(false);
  const [queueSteerRecovery, setQueueSteerRecovery] =
    useState<QueuedSteerRecovery | null>(readQueuedSteerRecovery);
  const queueSteerRecoveryRef = useRef(queueSteerRecovery);
  const [threadDetails, setThreadDetails] = useState<ThreadDetails | null>(
    null,
  );
  const [goalRevision,setGoalRevision]=useState(0);
  const [threadTokenUsage, setThreadTokenUsage] =
    useState<ThreadTokenUsage | null>(null);
  const selectedRef = useRef<string | null>(null);
  const initialNavigationRef = useRef<{
    route: ConversationRoute;
    invalid: boolean;
    threadTrail: ThreadTrailEntry[];
    parentRoute?: string;
  } | null>(null);
  if (!initialNavigationRef.current) {
    const parsed = parseRouteHash(window.location.hash);
    const savedThread = sessionStorage.getItem(selectedThreadKey);
    const route =
      parsed.route ??
      (parsed.invalid || !savedThread
        ? { kind: "new" as const }
        : { kind: "thread" as const, threadId: savedThread });
    const storedHistoryState = readHistoryState(
      window.history.state,
      routeHash(route),
    );
    initialNavigationRef.current = {
      route,
      invalid: parsed.invalid,
      threadTrail: storedHistoryState?.threadTrail ?? [],
      parentRoute: storedHistoryState?.parentRoute,
    };
  }
  const [route, setRoute] = useState(initialNavigationRef.current.route);
  const routeRef = useRef(route);
  const historyHandledRef = useRef("");
  const navigationInitializedRef = useRef(false);
  const [threadTrail, setThreadTrail] = useState<ThreadTrailEntry[]>(
    initialNavigationRef.current.threadTrail,
  );
  const threadTrailRef = useRef(threadTrail);
  const updateThreadTrail = useCallback(
    (
      next:
        | ThreadTrailEntry[]
        | ((current: ThreadTrailEntry[]) => ThreadTrailEntry[]),
    ) => {
      const value =
        typeof next === "function" ? next(threadTrailRef.current) : next;
      threadTrailRef.current = value;
      setThreadTrail(value);
    },
    [],
  );
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [optimisticMessages,setOptimisticMessages]=useState<OptimisticSubmission[]>([]);

  const itemsRef = useRef<TimelineItem[]>([]);
  const [activityGroupOverrides, setActivityGroupOverrides] = useState<
    Record<string, boolean>
  >({});
  const liveItemsRef = useRef(new Set<string>());
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const [loadingOlderItems, setLoadingOlderItems] = useState(false);
  const [loadingThread, setLoadingThread] = useState(false);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [turnActive, setTurnActive] = useState(false);
  const activeTurnSnapshotRef = useRef<{
    threadId: string | null;
    turnId: string | null;
    active: boolean;
  }>({ threadId: null, turnId: null, active: false });
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cwd, setCwd] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState("");
  const [sandboxMode, setSandboxMode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [interfaceLanguage,setInterfaceLanguageChoice] = useState<InterfaceLanguage>(readInterfaceLanguage);
  useEffect(()=>{setInterfaceLanguage(interfaceLanguage);},[interfaceLanguage]);
  const [showOptions, setShowOptions] = useState(false);
  const [disabledPluginIds, setDisabledPluginIds] = useState<string[]>([]);
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  const [completionSoundEnabled, setCompletionSoundEnabled] = useState(
    readCompletionSoundPreference,
  );
  const completionSoundEnabledRef = useRef(completionSoundEnabled);
  const completionAudioContextRef = useRef<AudioContext | null>(null);
  const eligibleCompletionTurnIdsRef = useRef(new Set<string>());
  const [pushConfiguration, setPushConfiguration] =
    useState<PushConfiguration | null>(null);
  const [questionNotificationsEnabled, setQuestionNotificationsEnabled] =
    useState(false);
  const [pushSetupState, setPushSetupState] =
    useState<PushSetupState>("loading");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState("");
  const [composer, setComposer] = useState("");
  const [completionTarget, setCompletionTarget] =
    useState<ComposerCompletionTarget | null>(null);
  const [completionItems, setCompletionItems] = useState<
    ComposerCompletionItem[]
  >([]);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [completionLoading, setCompletionLoading] = useState(false);
  const [completionError, setCompletionError] = useState("");
  const [skillsRevision, setSkillsRevision] = useState(0);
  const selectedSkillsRef = useRef<SelectedSkillReference[]>([]);
  const dismissedCompletionRef = useRef<{
    kind: ComposerCompletionTarget["kind"];
    token: string;
  } | null>(null);
  const completionRequestRef = useRef(0);
  const skillsCacheRef = useRef(
    new Map<string, SkillsListResponse["data"][number]["skills"]>(),
  );
  const pluginsCacheRef=useRef(
    new Map<string,Extract<ComposerCompletionItem,{kind:"plugin"}>[]>(),
  );
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const uploadsRef = useRef(uploads);
  const updateUploads = (
    next: PendingUpload[] | ((current: PendingUpload[]) => PendingUpload[]),
  ) => {
    const value = typeof next === "function" ? next(uploadsRef.current) : next;
    uploadsRef.current = value;
    setUploads(value);
  };
  const clearUploadsIfUnchanged = (expected: PendingUpload[]) => {
    const expectedIds = expected.map((upload) => upload.id).join("\u0000");
    updateUploads((current) =>
      current.map((upload) => upload.id).join("\u0000") === expectedIds
        ? []
        : current,
    );
  };
  const [compressingUploads, setCompressingUploads] = useState(false);
  const compressingUploadsRef = useRef(false);
  const [compactingThreadId, setCompactingThreadId] = useState<string | null>(
    null,
  );
  const compactingThreadRef = useRef<string | null>(null);
  const [sending, setSending] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const queueingRef = useRef(false);
  const queueAttemptRef = useRef<{
    key: string;
    clientUserMessageId: string;
  } | null>(null);
  const steerAttemptRef = useRef<{
    key: string;
    clientUserMessageId: string;
  } | null>(null);
  const [interrupting, setInterrupting] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const sidebarSearchRef = useRef<HTMLInputElement>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const threadNameRevisionRef = useRef(0);
  const threadNameUpdatesRef = useRef(
    new Map<string, { name: string; revision: number }>(),
  );
  const [threadContextMenu, setThreadContextMenu] =
    useState<ThreadContextMenu | null>(null);
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [questionAnswers, setQuestionAnswers] = useState<
    Record<string, string[]>
  >({});
  const { client, connection, connectionMessage, attach, detach } = useRpc();
  useEffect(()=>{pluginsCacheRef.current.clear();},[client]);
  const handlersRef = useRef({
    onNotification: (_method: string, _params: Record<string, unknown>) => {},
    onServerRequest: (_request: ApprovalPrompt) => {},
    onDisconnected: () => {},
    onReady: (_rpc: RpcClient) => {},
  });
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadContextMenuRef = useRef<HTMLDivElement>(null);
  const threadContextMenuFirstActionRef = useRef<HTMLButtonElement>(null);
  const threadContextMenuInvokerRef = useRef<HTMLButtonElement | null>(null);
  const threadLongPressRef = useRef<{
    thread: ThreadSummary;
    target: HTMLButtonElement;
    startX: number;
    startY: number;
    timer: number;
  } | null>(null);
  const suppressedLongPressClickRef = useRef<{
    threadId: string;
    timer: number;
  } | null>(null);
  const scrollWasNearBottom = useRef(true);
  const loadVersionRef = useRef(0);
  const queueLoadVersionRef = useRef(0);
  const threadNavigationRef = useRef(false);
  const sessionExpiredRef = useRef(false);
  const sessionProbeEpochRef = useRef(0);
  const sessionProbeSequenceRef = useRef(0);
  const sessionProbeInFlightRef = useRef<number | null>(null);
  const sessionProbeLastAtRef = useRef(0);
  const approvalPrompt = approvalQueue[0] ?? null;
  const observedSteerClientIdRef = useRef<string | null>(null);
  const updateCheckRef = useRef<(() => void) | null>(null);
  const newConversationRef = useRef<
    (historyMode?: "push" | "replace" | "none") => void
  >(() => {});

  useEffect(() => {
    completionSoundEnabledRef.current = completionSoundEnabled;
  }, [completionSoundEnabled]);

  useEffect(() => {
    queueSteerRecoveryRef.current = queueSteerRecovery;
  }, [queueSteerRecovery]);

  useEffect(() => {
    activeTurnSnapshotRef.current = {
      threadId: selectedThread?.id ?? null,
      turnId: activeTurnId,
      active: turnActive,
    };
  }, [activeTurnId, selectedThread?.id, turnActive]);

  const saveQueueSteerRecovery = useCallback(
    (recovery: QueuedSteerRecovery | null) => {
      if (recovery) {
        try {
          sessionStorage.setItem(
            queuedSteerRecoveryKey,
            JSON.stringify(recovery),
          );
        } catch {
          return false;
        }
      } else {
        queueSteerRecoveryRef.current = null;
        setQueueSteerRecovery(null);
        try {
          sessionStorage.removeItem(queuedSteerRecoveryKey);
        } catch {
          return false;
        }
        return true;
      }
      queueSteerRecoveryRef.current = recovery;
      setQueueSteerRecovery(recovery);
      return true;
    },
    [],
  );

  useEffect(() => {
    if (!completionSoundEnabled || typeof window.AudioContext === "undefined")
      return;
    const unlock = () => {
      try {
        const context =
          completionAudioContextRef.current ?? new window.AudioContext();
        completionAudioContextRef.current = context;
        if (context.state === "running") {
          document.removeEventListener("pointerdown", unlock);
          document.removeEventListener("keydown", unlock);
          return;
        }
        void context
          .resume()
          .then(() => {
            if (context.state !== "running") return;
            document.removeEventListener("pointerdown", unlock);
            document.removeEventListener("keydown", unlock);
          })
          .catch(() => {});
      } catch {}
    };
    document.addEventListener("pointerdown", unlock);
    document.addEventListener("keydown", unlock);
    return () => {
      document.removeEventListener("pointerdown", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, [completionSoundEnabled]);

  useEffect(() => {
    if (!status?.authenticated) return;
    if (!supportsQuestionNotifications()) {
      setPushSetupState("unsupported");
      return;
    }
    let cancelled = false;
    setPushSetupState("loading");
    setPushError("");
    void loadPushConfiguration()
      .then(async (configuration) => {
        if (cancelled) return;
        setPushConfiguration(configuration);
        const subscription = await getCurrentPushSubscription();
        if (cancelled) return;
        setQuestionNotificationsEnabled(Boolean(subscription));
        setPushSetupState(pushSetupStateFor(configuration));
        if (
          subscription &&
          configuration.ready &&
          configuration.publicKey &&
          Notification.permission === "granted"
        ) {
          try {
            await savePushSubscription(subscription);
          } catch (error) {
            if (cancelled) return;
            setPushSetupState("error");
            setPushError(shortError(error));
          }
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPushSetupState("error");
        setPushError(shortError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [status?.authenticated]);

  useEffect(
    () => () => {
      const context = completionAudioContextRef.current;
      completionAudioContextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    },
    [],
  );

  useEffect(() => {
    const root = document.documentElement;
    const systemPreference = window.matchMedia("(prefers-color-scheme: dark)");
    const applyTheme = () => {
      const resolvedTheme =
        themeChoice === "system"
          ? systemPreference.matches
            ? "dark"
            : "light"
          : themeChoice;
      root.dataset.themeChoice = themeChoice;
      root.dataset.theme = resolvedTheme;
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute(
          "content",
          resolvedTheme === "dark" ? "#111511" : "#f7f7f4",
        );
    };

    applyTheme();
    systemPreference.addEventListener("change", applyTheme);
    return () => systemPreference.removeEventListener("change", applyTheme);
  }, [themeChoice]);

  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let animationFrame = 0;
    let focusedTextControl = false;
    let heightBeforeFocus = viewport?.height ?? window.innerHeight;
    let previousWindowWidth = window.innerWidth;

    const isTextControl = (element: EventTarget | null): boolean => {
      if (element instanceof HTMLTextAreaElement) return true;
      if (!(element instanceof HTMLInputElement)) return false;
      return [
        "email",
        "number",
        "password",
        "search",
        "tel",
        "text",
        "url",
      ].includes(element.type);
    };

    const updateViewport = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const height = viewport?.height ?? window.innerHeight;
        const offsetTop = viewport?.offsetTop ?? 0;
        const mobileViewport = window.matchMedia(
          "(pointer: coarse), (max-width: 760px)",
        ).matches;
        const windowWidth = window.innerWidth;
        if (Math.abs(windowWidth - previousWindowWidth) > 120)
          heightBeforeFocus = height;
        previousWindowWidth = windowWidth;
        focusedTextControl = isTextControl(document.activeElement);
        root.style.setProperty("--app-viewport-height", `${height}px`);
        root.style.setProperty("--app-viewport-offset-top", `${offsetTop}px`);
        const keyboardVisible =
          mobileViewport &&
          focusedTextControl &&
          heightBeforeFocus - height > 120;
        root.dataset.keyboardVisible = String(keyboardVisible);
      });
    };

    const handleFocusIn = (event: FocusEvent) => {
      if (!isTextControl(event.target)) return;
      if (!focusedTextControl) {
        heightBeforeFocus = viewport?.height ?? window.innerHeight;
      }
      focusedTextControl = true;
      updateViewport();
    };

    const handleFocusOut = () => {
      updateViewport();
    };

    window.addEventListener("resize", updateViewport);
    window.addEventListener("scroll", updateViewport, { passive: true });
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    document.addEventListener("focusin", handleFocusIn);
    document.addEventListener("focusout", handleFocusOut);
    updateViewport();
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", updateViewport);
      window.removeEventListener("scroll", updateViewport);
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      document.removeEventListener("focusin", handleFocusIn);
      document.removeEventListener("focusout", handleFocusOut);
      delete root.dataset.keyboardVisible;
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-offset-top");
    };
  }, []);

  useEffect(() => {
    if (connection !== "online") {
      setApprovalQueue([]);
      setQuestionAnswers({});
      setThreadTokenUsage(null);
      queueLoadVersionRef.current += 1;
      setQueueThreadId(null);
      setQueuedSubmissions([]);
      setQueueLoading(false);
      setQueueError("");
      setQueueExpanded(false);
    }
  }, [connection]);
  const unknownRequest = Boolean(
    approvalPrompt &&
    ![
      "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval",
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "item/tool/call",
      "mcpServer/elicitation/request",
    ].includes(approvalPrompt.method),
  );

  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const refreshStatus = useCallback(async () => {
    setStatusError("");
    try {
      const response = await fetch("/api/status", {
        credentials: "same-origin",
      });
      if (response.status === 401) {
        setStatus({ authenticated: false, daemon: { available: false } });
        return;
      }
      if (!response.ok)
        throw new Error(`Status request failed (${response.status}).`);
      const result = (await response.json()) as DaemonStatus;
      setStatus(result);
    } catch (error) {
      setStatusError(shortError(error));
    } finally {
      setBooting(false);
    }
  }, []);

  useEffect(() => {
    if (navigationInitializedRef.current) return;
    const initial = initialNavigationRef.current!;
    routeRef.current = initial.route;
    selectedRef.current =
      initial.route.kind === "thread" ? initial.route.threadId : null;
    updateThreadTrail(initial.threadTrail);
    writeHistoryRoute(
      initial.route,
      initial.threadTrail,
      "replace",
      initial.parentRoute,
    );
    historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;
    if (initial.route.kind === "thread")
      sessionStorage.setItem(selectedThreadKey, initial.route.threadId);
    else sessionStorage.removeItem(selectedThreadKey);
    if (initial.invalid)
      setNotice({
        tone: "error",
        text: "That conversation link is not valid.",
      });
    navigationInitializedRef.current = true;
  }, [updateThreadTrail]);

  const handleSessionExpired = useCallback(() => {
    if (sessionExpiredRef.current) return;
    sessionExpiredRef.current = true;
    ++sessionProbeEpochRef.current;
    sessionProbeInFlightRef.current = null;
    ++loadVersionRef.current;
    detach();
    selectedRef.current = null;
    setThreadTokenUsage(null);
    queueLoadVersionRef.current += 1;
    setQueueThreadId(null);
    setQueuedSubmissions([]);
    setQueueLoading(false);
    setQueueError("");
    setQueueExpanded(false);
    const newRoute: ConversationRoute = { kind: "new" };
    routeRef.current = newRoute;
    setRoute(newRoute);
    updateThreadTrail([]);
    writeHistoryRoute(newRoute, [], "replace");
    historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;
    sessionStorage.removeItem(selectedThreadKey);
    setStatus({ authenticated: false, daemon: { available: false } });
    setStatusError("");
    setAuthError(
      "Your session expired. Sign in again. Your unsent draft is still here.",
    );
    setToken("");
    setThreads([]);
    threadsRef.current = [];
    setSelectedThread(null);
    setThreadDetails(null);
    setItems([]);
    itemsRef.current = [];
    liveItemsRef.current.clear();
    setItemCursor(null);
    setLoadingThread(false);
    setActiveTurnId(null);
    setTurnActive(false);
    activeTurnSnapshotRef.current = {
      threadId: null,
      turnId: null,
      active: false,
    };
    setModels([]);
    setModel("");
    setEffort("");
    setCwd("");
    setApprovalPolicy("");
    setSandboxMode("");
    setApprovalQueue([]);
    setQuestionAnswers({});
    setSending(false);
    setInterrupting(false);
    setShowSettings(false);
  }, [detach, updateThreadTrail]);

  const checkSessionAfterDisconnect = useCallback(() => {
    if (
      sessionExpiredRef.current ||
      sessionProbeInFlightRef.current !== null ||
      Date.now() - sessionProbeLastAtRef.current < 2500
    )
      return;

    const probeId = ++sessionProbeSequenceRef.current;
    const epoch = sessionProbeEpochRef.current;
    sessionProbeInFlightRef.current = probeId;
    sessionProbeLastAtRef.current = Date.now();
    void fetch("/api/status", { credentials: "same-origin" })
      .then(async (response) => {
        if (epoch !== sessionProbeEpochRef.current) return;
        if (response.status === 401) {
          handleSessionExpired();
          return;
        }
        if (response.ok) {
          const result = (await response.json()) as DaemonStatus;
          if (!result.authenticated) handleSessionExpired();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (sessionProbeInFlightRef.current === probeId)
          sessionProbeInFlightRef.current = null;
      });
  }, [handleSessionExpired]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    const threadId = selectedThread?.id ?? null;
    if (noticeThreadIdRef.current === threadId) return;
    noticeThreadIdRef.current = threadId;
    setNotice((current) =>
      current && /context compaction/i.test(current.text) ? null : current,
    );
  }, [selectedThread?.id]);

  useEffect(() => {
    const loadedAssets = appAssetSignature(document);
    if (!loadedAssets.length) return;
    let cancelled = false;
    let checking = false;
    const checkForUpdate = async () => {
      if (cancelled || checking || document.visibilityState !== "visible")
        return;
      checking = true;
      if ("serviceWorker" in navigator) {
        void navigator.serviceWorker
          .getRegistration()
          .then((registration) => registration?.update())
          .catch(() => {});
      }
      try {
        const response = await fetch("/", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!response.ok) return;
        const html = await response.text();
        if (cancelled) return;
        const latestDocument = new DOMParser().parseFromString(
          html,
          "text/html",
        );
        const latestAssets = appAssetSignature(latestDocument);
        if (
          latestAssets.length &&
          (latestAssets.length !== loadedAssets.length ||
            latestAssets.some((asset, index) => asset !== loadedAssets[index]))
        )
          setNewVersionAvailable(true);
      } catch {
      } finally {
        checking = false;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkForUpdate();
    };
    const handleOnline = () => void checkForUpdate();
    updateCheckRef.current = () => void checkForUpdate();
    void checkForUpdate();
    const interval = window.setInterval(
      () => void checkForUpdate(),
      5 * 60 * 1000,
    );
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);
    return () => {
      cancelled = true;
      updateCheckRef.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => {
    if (connection === "online") updateCheckRef.current?.();
  }, [connection]);

  const refreshThreads = useCallback(
    async (rpc: RpcClient, archived = archivedThreads, append = false) => {
      const nameRevisionAtRequest = threadNameRevisionRef.current;
      try {
        const result = await rpc.request<{
          data: ThreadSummary[];
          nextCursor: string | null;
        }>("thread/list", {
          limit: 100,
          sourceKinds: ["cli", "vscode", "appServer"],
          sortKey: archived ? "updated_at" : "recency_at",
          sortDirection: "desc",
          archived,
          ...(append && threadCursor ? { cursor: threadCursor } : {}),
        });
        const data = result.data.map((thread) => {
          const update = threadNameUpdatesRef.current.get(thread.id);
          return update && update.revision > nameRevisionAtRequest
            ? { ...thread, name: update.name }
            : thread;
        });
        setThreads((current) =>
          mergeThreadPage(current, data, append, !archived),
        );
        setThreadCursor(result.nextCursor);
        // The daemon excludes spawned agents from default thread/list results.
        // Fetch agent sources independently so normal conversation pagination is unchanged.
        try {
          const agents: ThreadSummary[] = [];
          let cursor: string | null = null;
          for (let page = 0; page < 20; page++) {
            const batch: { data: ThreadSummary[]; nextCursor: string | null } = await rpc.request("thread/list", {
              limit: 100,
              archived,
              sortKey: archived ? "updated_at" : "recency_at",
              sortDirection: "desc",
              sourceKinds: subagentSourceKinds,
              ...(cursor ? { cursor } : {}),
            });
            agents.push(...batch.data);
            cursor = batch.nextCursor;
            if (!cursor) break;
          }
          setSubagentThreads(agents);
        } catch (error) {
          console.warn("Unable to load subagent threads", error);
        }

      } catch (error) {
        setNotice({
          tone: "error",
          text: `Could not load conversations: ${shortError(error)}`,
        });
      }
    },
    [archivedThreads, threadCursor],
  );

  const refreshProjects = useCallback(async (rpc: RpcClient) => {
    try {
      const projects: CodexProject[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result: {data: CodexProject[];nextCursor:string|null} = await rpc.request("project/list",{
          limit:100,...(cursor?{cursor}:{}),
        });
        projects.push(...result.data);
        cursor=result.nextCursor;
        if (!cursor) break;
      }
      setCodexProjects(projects);
    } catch (error) {
      setNotice({tone:"error",text:"Could not load Codex projects: "+shortError(error)});
    }
  },[]);
  useEffect(() => {
    if (!client || connection !== "online") return;
    void refreshProjects(client);
  }, [client,connection,refreshProjects]);

  const openProjectCreate = () => {
    setProjectCreateName("");
    setProjectCreateRoot(selectedThread?.cwd || cwd || "");
    setProjectCreateIdempotencyKey(clientUUID());
    setProjectCreateOpen(true);
  };
  const createCodexProject = async () => {
    const name=projectCreateName.trim();
    const root=projectCreateRoot.trim();
    if(!client||!name||!root||projectMutationBusy)return;
    let params;
    try { params=buildProjectCreateParams(name,root,projectCreateIdempotencyKey); }
    catch(error) { setNotice({tone:"error",text:shortError(error)}); return; }
    setProjectMutationBusy(true);
    try {
      const result=await client.request<{project:CodexProject}>("project/create",params);
      if(!result?.project?.id)throw new Error("Codex did not return the created project.");
      setCodexProjects(current=>[result.project,...current.filter(project=>project.id!==result.project.id)]);
      setNewProjectId(result.project.id);
      setCwd(root);
      setProjectCreateOpen(false);
      setProjectCreateIdempotencyKey("");
      setNotice({tone:"success",text:"Created Codex project: "+result.project.name});
      void refreshProjects(client);
    } catch(error) {
      setNotice({tone:"error",text:"Could not create project: "+shortError(error)});
    } finally {
      setProjectMutationBusy(false);
    }
  };

  const renameCodexProject = async (projectId:string) => {
    const name=projectRenameValue.trim();
    if(!client||!name||projectMutationBusy)return;
    setProjectMutationBusy(true);
    try {
      await client.request("project/update",{projectId,name});
      setCodexProjects(old=>old.map(p=>p.id===projectId?{...p,name}:p));
      setProjectRenameId(null);
      void refreshProjects(client);
    } catch(error) {setNotice({tone:"error",text:"Could not rename project: "+shortError(error)});}
    finally {setProjectMutationBusy(false);}
  };
  const moveConversationToProject = async () => {
    if (!client || !projectMoveThread || projectMutationBusy) return;
    const threadId=projectMoveThread.id;
    const projectId=projectMoveTarget;
    setProjectMutationBusy(true);
    try {
      await client.request("thread/metadata/update",{threadId,projectId});
      const patch=(t:ThreadSummary)=>t.id===threadId?{...t,projectId:projectId||null}:t;
      setThreads(current=>current.map(patch));
      threadsRef.current=threadsRef.current.map(patch);
      setSubagentThreads(current=>current.map(patch));
      setSelectedThread(current=>current?.id===threadId?patch(current):current);
      setProjectMoveThread(null);
      if (client) {void refreshProjects(client);void refreshThreads(client,archivedThreads,false);}
    } catch(error){setNotice({tone:"error",text:"Could not change project: "+shortError(error)});}
    finally{setProjectMutationBusy(false);}
  };

  // Other daemon clients (notably Codex Desktop) may own the active thread.
  // Poll its persisted status so sidebar indicators don't depend on this
  // browser receiving that thread's turn notifications.
  useEffect(() => {
    if (!client || connection !== "online") return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshThreads(client, archivedThreads, false);
    }, 20_000);
    return () => window.clearInterval(timer);
  }, [client, connection, archivedThreads, refreshThreads]);

  const loadModels = useCallback(
    async (rpc: RpcClient) => {
      try {
        const result = await rpc.request<{
          data: ModelOption[];
          nextCursor: string | null;
        }>("model/list", {
          limit: 100,
          includeHidden: false,
        });
        setModels(result.data);
        setModel(
          (current) =>
            current ||
            result.data.find((entry) => entry.isDefault)?.model ||
            result.data[0]?.model ||
            "",
        );
        const selectedModel =
          result.data.find((entry) => entry.model === model) ??
          result.data.find((entry) => entry.isDefault) ??
          result.data[0];
        if (selectedModel)
          setEffort(
            (current) => current || selectedModel.defaultReasoningEffort,
          );
      } catch (error) {
        setNotice({
          tone: "error",
          text: `Could not load models: ${shortError(error)}`,
        });
      }
    },
    [model],
  );

  const refreshThreadQueue = useCallback(
    async (rpc: RpcClient, threadId: string) => {
      const version = ++queueLoadVersionRef.current;
      try {
        const submissions = await listThreadQueue(rpc, threadId);
        if (
          version !== queueLoadVersionRef.current ||
          selectedRef.current !== threadId
        )
          return;
        setQueueThreadId(threadId);
        setQueuedSubmissions(submissions);
        setQueueError("");
      } catch (error) {
        if (
          version !== queueLoadVersionRef.current ||
          selectedRef.current !== threadId
        )
          return;
        setQueueThreadId(threadId);
        setQueueError(shortError(error));
      } finally {
        if (
          version === queueLoadVersionRef.current &&
          selectedRef.current === threadId
        )
          setQueueLoading(false);
      }
    },
    [],
  );

  const applyThreadName = (threadId: string, name: string) => {
    if (!threadId) return;
    const revision = ++threadNameRevisionRef.current;
    threadNameUpdatesRef.current.set(threadId, { name, revision });
    threadsRef.current = threadsRef.current.map((thread) =>
      thread.id === threadId ? { ...thread, name } : thread,
    );
    setThreads((current) =>
      current.map((thread) =>
        thread.id === threadId ? { ...thread, name } : thread,
      ),
    );
    setSelectedThread((current) =>
      current?.id === threadId ? { ...current, name } : current,
    );
    setThreadDetails((current) => {
      if (!current || selectedRef.current !== threadId) return current;
      return {
        ...current,
        thread: Object.assign({}, current.thread, { name }),
      };
    });
    const nextTrail = threadTrailRef.current.map((entry) =>
      entry.id === threadId ? { ...entry, title: name } : entry,
    );
    if (
      nextTrail.some((entry, index) => entry !== threadTrailRef.current[index])
    ) {
      updateThreadTrail(nextTrail);
      const historyState = readHistoryState(
        window.history.state,
        routeHash(routeRef.current),
      );
      writeHistoryRoute(
        routeRef.current,
        nextTrail,
        "replace",
        historyState?.parentRoute,
      );
    }
  };

  const handleNotification = useCallback(
    (method: string, params: Record<string, unknown>) => {
      if (method === "skills/changed") {
        skillsCacheRef.current.clear();
        setSkillsRevision((current) => current + 1);
        return;
      }
      if (method === "error") {
        const error = isRecord(params.error) ? params.error : params;
        setNotice({
          tone: "error",
          text: asString(error.message, "Codex reported an error."),
        });
        return;
      }
      if (method === "thread/started" && isRecord(params.thread)) {
        const newThread = params.thread as unknown as ThreadSummary;
        if (!archivedThreads)
          setThreads((current) =>
            mergeThreadPage(current, [newThread], true, true),
          );
        return;
      }
      if (method === "thread/name/updated") {
        const threadId = asString(params.threadId);
        if (typeof params.name === "string")
          applyThreadName(threadId, params.name);
        return;
      }
      if (method === "thread/archived" || method === "thread/unarchived") {
        const threadId = asString(params.threadId);
        setThreads((current) =>
          current.filter((entry) => entry.id !== threadId),
        );
        return;
      }
      if (method === "serverRequest/resolved") {
        const threadId = asString(params.threadId);
        setApprovalQueue((current) =>
          current.filter(
            (prompt) =>
              prompt.id !== params.requestId ||
              (threadId && asString(prompt.params.threadId) !== threadId),
          ),
        );
        return;
      }

      if (method === "thread/goal/updated" || method === "thread/goal/cleared") {
        if(asString(params.threadId)===selectedRef.current)
          setGoalRevision(value=>value+1);
        return;
      }
      if (method === "thread/queue/changed") {
        const threadId = asString(params.threadId);
        if (threadId && threadId === selectedRef.current && client)
          void refreshThreadQueue(client, threadId);
        return;
      }

      if (method === "thread/tokenUsage/updated") {
        const threadId = asString(params.threadId);
        if (threadId !== selectedRef.current) return;
        const tokenUsage = params.tokenUsage;
        setThreadTokenUsage(
          isRecord(tokenUsage) && isRecord(tokenUsage.last)
            ? (tokenUsage as unknown as ThreadTokenUsage)
            : null,
        );
        return;
      }

      if (method === "turn/started" && isRecord(params.turn)) {
        const startedTurnId = asString(params.turn.id);
        if (startedTurnId)
          activeTurnSnapshotRef.current = {
            threadId: asString(params.threadId) || selectedRef.current,
            turnId: startedTurnId,
            active: true,
          };
        if (startedTurnId)
          eligibleCompletionTurnIdsRef.current.add(startedTurnId);
      }
      if (method === "turn/completed" && isRecord(params.turn)) {
        const completedTurnId = asString(params.turn.id);
        if (
          completedTurnId &&
          eligibleCompletionTurnIdsRef.current.delete(completedTurnId) &&
          completionSoundEnabledRef.current &&
          completionAudioContextRef.current
        ) {
          try {
            playCompletionTone(completionAudioContextRef.current);
          } catch {}
        }
      }

      const threadId = asString(params.threadId);
      if (threadId && method === "turn/started") {
        setFailedThreadIds((old) => {
          if (!old.has(threadId)) return old;
          const updated = new Set(old); updated.delete(threadId); return updated;
        });
      }
      if (threadId && method === "turn/completed" && isRecord(params.turn)) {
        const failed = params.turn.status === "failed";
        setFailedThreadIds((old) => {
          if (failed === old.has(threadId)) return old;
          const updated = new Set(old);
          if (failed) updated.add(threadId); else updated.delete(threadId);
          return updated;
        });
      }
      if (method === "turn/started" && client)
        void refreshThreads(client, archivedThreads, false);
      if (threadId && threadId !== selectedRef.current) return;

      if (
        method === "item/started" &&
        isRecord(params.item) &&
        params.item.type === "contextCompaction"
      )
        setThreadTokenUsage(null);

      if (method === "turn/started" && isRecord(params.turn)) {
        const turn = params.turn;
        setActiveTurnId(asString(turn.id) || null);
        setTurnActive(true);
        return;
      }
      if (method === "turn/completed" && isRecord(params.turn)) {
        const turn = params.turn;
        const completedTurnId = asString(turn.id);
        if (!activeTurnId || completedTurnId === activeTurnId) {
          if (
            activeTurnSnapshotRef.current.threadId === threadId &&
            activeTurnSnapshotRef.current.turnId === completedTurnId
          )
            activeTurnSnapshotRef.current = {
              threadId,
              turnId: null,
              active: false,
            };
          setTurnActive(false);
          setActiveTurnId(null);
        }
        return;
      }
      if (method === "thread/status/changed") {
        const status = params.status;
        const isActive = isRecord(status) && status.type === "active";
        activeTurnSnapshotRef.current = {
          threadId,
          turnId: isActive ? activeTurnSnapshotRef.current.turnId : null,
          active: isActive,
        };
        setTurnActive(isActive);
        if (!isActive) setActiveTurnId(null);
        return;
      }

      if (method === "item/started" || method === "item/completed") {
        if (!isRecord(params.item) || typeof params.item.type !== "string")
          return;
        const next = params.item as ThreadItem;
        if (
          method === "item/started" &&
          next.type === "userMessage" &&
          typeof next.clientId === "string"
        ) {
          const recovery = queueSteerRecoveryRef.current;
          if (
            recovery?.threadId === threadId &&
            recovery.submission.clientUserMessageId === next.clientId
          ) {
            observedSteerClientIdRef.current = next.clientId;
            saveQueueSteerRecovery(null);
            setNotice({
              tone: "success",
              text: "This saved queued message has already started in the conversation.",
            });
          }
        }
        liveItemsRef.current.add(next.id);
        const turnId = asString(params.turnId);
        setItems((current) => {
          const found = current.findIndex((entry) => entry.item.id === next.id);
          const replacement: TimelineItem = {
            turnId,
            item: next,
            startedAtMs:
              typeof params.startedAtMs === "number"
                ? params.startedAtMs
                : null,
            completedAtMs:
              typeof params.completedAtMs === "number"
                ? params.completedAtMs
                : null,
            streaming: method === "item/started",
          };
          if (found < 0) return [...current, replacement];
          const updated = [...current];
          updated[found] = replacement;
          return updated;
        });
        return;
      }

      if (
        method === "item/agentMessage/delta" ||
        method === "item/plan/delta" ||
        method === "item/reasoning/textDelta" ||
        method === "item/reasoning/summaryTextDelta"
      ) {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        if (!itemId || !delta) return;
        liveItemsRef.current.add(itemId);
        setItems((current) =>
          updateItem(current, itemId, (item) => {
            const key = method.startsWith("item/reasoning/")
              ? method === "item/reasoning/textDelta"
                ? "content"
                : "summary"
              : "text";
            const prior = item[key];
            if (key !== "text") {
              const indexKey =
                key === "summary" ? "summaryIndex" : "contentIndex";
              const requestedIndex = params[indexKey];
              const partIndex =
                typeof requestedIndex === "number" &&
                Number.isInteger(requestedIndex) &&
                requestedIndex >= 0
                  ? requestedIndex
                  : 0;
              const parts = Array.isArray(prior)
                ? prior.map((part) => asString(part))
                : prior
                  ? [asString(prior)]
                  : [];
              while (parts.length <= partIndex) parts.push("");
              parts[partIndex] += delta;
              return { ...item, [key]: parts };
            }
            if (Array.isArray(prior))
              return { ...item, [key]: [...prior, delta] };
            return { ...item, [key]: `${asString(prior)}${delta}` };
          }),
        );
        return;
      }
      if (method === "item/reasoning/summaryPartAdded") {
        const itemId = asString(params.itemId);
        const requestedIndex = params.summaryIndex;
        if (!itemId) return;
        const partIndex =
          typeof requestedIndex === "number" &&
          Number.isInteger(requestedIndex) &&
          requestedIndex >= 0
            ? requestedIndex
            : 0;
        liveItemsRef.current.add(itemId);
        setItems((current) =>
          updateItem(current, itemId, (item) => {
            const parts = Array.isArray(item.summary)
              ? item.summary.map((part) => asString(part))
              : item.summary
                ? [asString(item.summary)]
                : [];
            while (parts.length <= partIndex) parts.push("");
            return { ...item, summary: parts };
          }),
        );
        return;
      }
      if (method === "item/commandExecution/outputDelta") {
        const itemId = asString(params.itemId);
        const delta = asString(params.delta);
        liveItemsRef.current.add(itemId);
        setItems((current) =>
          updateItem(current, itemId, (item) => ({
            ...item,
            aggregatedOutput: `${asString(item.aggregatedOutput)}${delta}`,
          })),
        );
        return;
      }
      if (method === "item/fileChange/patchUpdated") {
        const itemId = asString(params.itemId);
        if (!Array.isArray(params.changes)) return;
        liveItemsRef.current.add(itemId);
        setItems((current) =>
          updateItem(current, itemId, (item) => ({
            ...item,
            changes: params.changes,
          })),
        );
        return;
      }
    },
    [
      activeTurnId,
      applyThreadName,
      archivedThreads,
      client,
      refreshThreadQueue,
      refreshThreads,
      saveQueueSteerRecovery,
    ],
  );

  const handleServerRequest = useCallback((request: ApprovalPrompt) => {
    if (request.method === "item/tool/call") {
      const name =
        [request.params.namespace, request.params.tool]
          .filter(Boolean)
          .join("/") || "unnamed tool";
      setNotice({
        tone: "info",
        text: `Codex requested client tool “${name}”. Review the request and return an unsupported response.`,
      });
    }
    setApprovalQueue((current) =>
      current.some((prompt) => prompt.id === request.id)
        ? current
        : [...current, request],
    );
  }, []);

  const openThread = useCallback(
    async (rpc: RpcClient, threadId: string, announce = false) => {
      const version = ++loadVersionRef.current;
      const nameRevisionAtRequest = threadNameRevisionRef.current;
      selectedRef.current = threadId;
      if (announce) setMobileSidebarOpen(false);
      const summary =
        threadsRef.current.find((thread) => thread.id === threadId) ?? null;
      setSelectedThread(summary);
      setThreadTokenUsage(null);
      queueLoadVersionRef.current += 1;
      setQueueThreadId(threadId);
      setQueuedSubmissions([]);
      setQueueLoading(true);
      setQueueError("");
      setQueueExpanded(false);
      setItems([]);
      setThreadDetails(null);
      setLoadingThread(true);
      setItemCursor(null);
      setActiveTurnId(null);
      activeTurnSnapshotRef.current = {
        threadId,
        turnId: null,
        active: false,
      };
      liveItemsRef.current.clear();
      try {
        const response = await rpc.request<
          ThreadDetails & {
            thread: ThreadDetails["thread"] & {
              id: string;
              name?: string | null;
              preview?: string;
              cwd?: string;
              canAcceptDirectInput?: boolean | null;
              parentThreadId?: string | null;
            };
          }
        >("thread/resume", {
          threadId,
          excludeTurns: true,
        });
        if (version !== loadVersionRef.current) return;
        const nameUpdate = threadNameUpdatesRef.current.get(threadId);
        const confirmedName =
          nameUpdate && nameUpdate.revision > nameRevisionAtRequest
            ? nameUpdate.name
            : undefined;
        const detailsResponse =
          confirmedName === undefined
            ? response
            : {
                ...response,
                thread: { ...response.thread, name: confirmedName },
              };
        setThreadDetails(detailsResponse);
        setDisabledPluginIds(Array.isArray(response.disabledPluginIds) ? response.disabledPluginIds : []);
        void refreshThreadQueue(rpc, threadId);
        setCwd(response.cwd || summary?.cwd || "");
        setModel(response.model || summary?.model || "");
        setEffort(response.reasoningEffort || summary?.reasoningEffort || "");
        setApprovalPolicy("");
        setSandboxMode("");
        setTurnActive(
          isRecord(response.thread.status) &&
            response.thread.status.type === "active",
        );
        activeTurnSnapshotRef.current = {
          threadId,
          turnId: null,
          active:
            isRecord(response.thread.status) &&
            response.thread.status.type === "active",
        };
        if (response.thread.canAcceptDirectInput === false) {
          setShowSettings(false);
          setShowOptions(false);
        }
        setSelectedThread((current) => {
          if (
            version !== loadVersionRef.current ||
            selectedRef.current !== threadId
          ) {
            return current;
          }
          const existing =
            current?.id === threadId
              ? current
              : summary?.id === threadId
                ? summary
                : null;
          return {
            ...(existing ?? {
              id: threadId,
              name: null,
              preview: "",
              cwd: response.cwd,
              updatedAt: 0,
              createdAt: 0,
              recencyAt: null,
              model: response.model,
              reasoningEffort: response.reasoningEffort,
              status: response.thread.status,
              canAcceptDirectInput: null,
            }),
            cwd: response.cwd || existing?.cwd || "",
            model: response.model || existing?.model || null,
            reasoningEffort:
              response.reasoningEffort ?? existing?.reasoningEffort ?? null,
            status: response.thread.status,
            canAcceptDirectInput:
              response.thread.canAcceptDirectInput ??
              existing?.canAcceptDirectInput ??
              null,
            name:
              confirmedName ?? response.thread.name ?? existing?.name ?? null,
            preview: response.thread.preview ?? existing?.preview ?? "",
          };
        });
        if (
          response.thread.parentThreadId &&
          response.thread.parentThreadId !== threadId &&
          threadTrailRef.current.length === 0 &&
          routeRef.current.kind === "thread" &&
          routeRef.current.threadId === threadId
        ) {
          const parentId = response.thread.parentThreadId;
          const parent = threadsRef.current.find(
            (thread) => thread.id === parentId,
          );
          const trail = [
            {
              id: parentId,
              title: parent ? titleFor(parent) : "Parent conversation",
            },
          ];
          updateThreadTrail(trail);
          const currentHistoryState = readHistoryState(
            window.history.state,
            routeHash(routeRef.current),
          );
          writeHistoryRoute(
            routeRef.current,
            trail,
            "replace",
            currentHistoryState?.parentRoute,
          );
          historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;
        }

        const [page, turnPage] = await Promise.all([
          rpc.request<{ data: ThreadItemEntry[]; nextCursor: string | null }>(
            "thread/items/list",
            {
              threadId,
              limit: 50,
              sortDirection: "desc",
            },
          ),
          rpc.request<{
            data: Array<{ id: string; status: string }>;
            nextCursor: string | null;
          }>("thread/turns/list", {
            threadId,
            limit: 5,
            sortDirection: "desc",
            itemsView: "notLoaded",
          }),
        ]);
        if (version !== loadVersionRef.current) return;
        setFailedThreadIds((current) => {
          const failed = turnPage.data[0]?.status === "failed";
          if (failed === current.has(threadId)) return current;
          const next = new Set(current);
          if (failed) next.add(threadId); else next.delete(threadId);
          return next;
        });
        const sorted = [...page.data].reverse().map((entry) => ({ ...entry }));
        const merged = mergeHistoryWithLive(
          sorted,
          itemsRef.current,
          liveItemsRef.current,
        );
        setItems(merged);
        setItemCursor(page.nextCursor);
        const activeTurn = turnPage.data.find(
          (turn) => turn.status === "inProgress",
        );
        if (activeTurn) {
          eligibleCompletionTurnIdsRef.current.add(activeTurn.id);
          setActiveTurnId(activeTurn.id);
          activeTurnSnapshotRef.current = {
            threadId,
            turnId: activeTurn.id,
            active: true,
          };
        }
        setLoadingThread(false);
        sessionStorage.setItem(selectedThreadKey, threadId);
        requestAnimationFrame(() => {
          const view = timelineRef.current;
          if (view) view.scrollTop = view.scrollHeight;
        });
      } catch (error) {
        if (version !== loadVersionRef.current) return;
        setLoadingThread(false);
        setQueueLoading(false);
        setNotice({
          tone: "error",
          text: `Could not open conversation: ${shortError(error)}`,
        });
      }
    },
    [refreshThreadQueue, updateThreadTrail],
  );

  const navigateToThread = useCallback(
    (
      threadId: string,
      trail: ThreadTrailEntry[],
      historyMode: "push" | "replace" | "none" = "push",
      parentRoute?: string,
    ) => {
      const nextRoute: ConversationRoute = { kind: "thread", threadId };
      if (historyMode !== "none")
        writeHistoryRoute(nextRoute, trail, historyMode, parentRoute);
      routeRef.current = nextRoute;
      setRoute(nextRoute);
      updateThreadTrail(trail);
      selectedRef.current = threadId;
      setThreadTokenUsage(null);
      queueLoadVersionRef.current += 1;
      setQueueThreadId(null);
      setQueuedSubmissions([]);
      setQueueLoading(false);
      setQueueError("");
      setQueueExpanded(false);
      sessionStorage.setItem(selectedThreadKey, threadId);
      historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;

      if (
        client &&
        connection === "online" &&
        status?.authenticated &&
        status.daemon.available
      )
        return openThread(client, threadId, historyMode === "push");

      ++loadVersionRef.current;
      setSelectedThread(null);
      setThreadDetails(null);
      setItems([]);
      itemsRef.current = [];
      liveItemsRef.current.clear();
      setItemCursor(null);
      setLoadingThread(true);
      setActiveTurnId(null);
      setTurnActive(false);
      activeTurnSnapshotRef.current = {
        threadId: null,
        turnId: null,
        active: false,
      };
      return undefined;
    },
    [
      client,
      connection,
      openThread,
      status?.authenticated,
      status?.daemon.available,
      updateThreadTrail,
    ],
  );

  const copyConversationLink = async (threadId:string) => {
    try {
      const link=codexThreadLink(threadId);
      if(navigator.clipboard?.writeText){
        try { await navigator.clipboard.writeText(link); }
        catch {
          const input=document.createElement("textarea");
          input.value=link;input.style.position="fixed";input.style.opacity="0";
          document.body.appendChild(input);input.select();
          const copied=document.execCommand("copy");input.remove();
          if(!copied)throw new Error("Clipboard permission denied.");
        }
      } else {
        const input=document.createElement("textarea");
        input.value=link;input.style.position="fixed";input.style.opacity="0";
        document.body.appendChild(input);input.select();
        const copied=document.execCommand("copy");input.remove();
        if(!copied)throw new Error("Clipboard is unavailable.");
      }
      setNotice({tone:"success",text:"Codex thread reference copied."});
    }catch(error){
      setNotice({tone:"error",text:"Could not copy link: "+shortError(error)});
    }
  };
  const forkConversationAtMessage = async (entry:TimelineItem) => {
    if(!client||!selectedThread?.id||!entry.turnId||entry.streaming||forkBusy)return;
    if(entry.item.type!=="userMessage"&&entry.item.type!=="agentMessage")return;
    setForkBusy(true);
    try{
      const params=forkAtMessage(selectedThread.id,entry.turnId,entry.item.type);
      const result=await client.request<{thread:{id:string}}>("thread/fork",params);
      const id=result?.thread?.id;
      if(!id)throw new Error("Codex did not return a forked thread.");
      await navigateToThread(id,[],"push");
      void refreshThreads(client,false,false);
      setNotice({tone:"success",text:"Conversation fork created."});
    }catch(error){
      setNotice({tone:"error",text:"Could not fork conversation: "+shortError(error)});
    }finally{setForkBusy(false);}
  };

  const openAgentThread = useCallback(
    (threadId: string, parentThreadId?: string) => {
      const parentId = parentThreadId || selectedThread?.id;
      if (
        !selectedThread ||
        !parentId ||
        !threadId ||
        threadId === selectedThread.id ||
        (parentThreadId && parentThreadId !== selectedThread.id) ||
        loadingThread ||
        threadNavigationRef.current
      )
        return;
      threadNavigationRef.current = true;
      const parentTrail = [
        ...threadTrailRef.current,
        {
          id: parentId,
          title: titleFor(selectedThread),
        },
      ];
      const parentRoute = routeHash(routeRef.current);
      const navigation = navigateToThread(
        threadId,
        parentTrail,
        "push",
        parentRoute,
      );
      if (navigation)
        void navigation.finally(() => {
          threadNavigationRef.current = false;
        });
      else threadNavigationRef.current = false;
    },
    [loadingThread, navigateToThread, selectedThread],
  );

  const returnToParentThread = useCallback(() => {
    const parent = threadTrail.at(-1);
    if (!parent || loadingThread || threadNavigationRef.current) return;
    const expectedParentRoute = routeHash({
      kind: "thread",
      threadId: parent.id,
    });
    const currentState = readHistoryState(
      window.history.state,
      routeHash(routeRef.current),
    );
    if (currentState?.parentRoute === expectedParentRoute) {
      window.history.back();
      return;
    }
    threadNavigationRef.current = true;
    const parentTrail = threadTrailRef.current.slice(0, -1);
    const parentOfParent = parentTrail.at(-1);
    const parentRoute = parentOfParent
      ? routeHash({ kind: "thread", threadId: parentOfParent.id })
      : undefined;
    const navigation = navigateToThread(
      parent.id,
      parentTrail,
      "push",
      parentRoute,
    );
    if (navigation)
      void navigation.finally(() => {
        threadNavigationRef.current = false;
      });
    else threadNavigationRef.current = false;
  }, [loadingThread, navigateToThread, threadTrail]);

  const onReady = useCallback(
    (rpc: RpcClient) => {
      ++sessionProbeEpochRef.current;
      sessionProbeInFlightRef.current = null;
      sessionProbeLastAtRef.current = 0;
      sessionExpiredRef.current = false;
      void loadModels(rpc);
      void refreshThreads(rpc, archivedThreads, false);
      if (routeRef.current.kind === "thread")
        void openThread(rpc, routeRef.current.threadId, false);
    },
    [archivedThreads, loadModels, openThread, refreshThreads],
  );

  handlersRef.current = {
    onNotification: handleNotification,
    onServerRequest: handleServerRequest,
    onDisconnected: checkSessionAfterDisconnect,
    onReady,
  };

  const updateCompletionSound = (enabled: boolean) => {
    completionSoundEnabledRef.current = enabled;
    setCompletionSoundEnabled(enabled);
    try {
      localStorage.setItem(completionSoundKey, String(enabled));
    } catch {}
    if (typeof window.AudioContext === "undefined") return;
    if (enabled) {
      try {
        const context =
          completionAudioContextRef.current ?? new window.AudioContext();
        completionAudioContextRef.current = context;
        void context.resume().catch(() => {});
      } catch {}
      return;
    }
    const context = completionAudioContextRef.current;
    completionAudioContextRef.current = null;
    if (context && context.state !== "closed") void context.close();
  };

  const retryQuestionNotificationSetup = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    setPushSetupState("loading");
    setPushError("");
    try {
      const configuration = await loadPushConfiguration();
      setPushConfiguration(configuration);
      const subscription = await getCurrentPushSubscription();
      setQuestionNotificationsEnabled(Boolean(subscription));
      setPushSetupState(pushSetupStateFor(configuration));
      if (
        subscription &&
        configuration.ready &&
        configuration.publicKey &&
        Notification.permission === "granted"
      ) {
        await savePushSubscription(subscription);
      }
    } catch (error) {
      setPushSetupState("error");
      setPushError(shortError(error));
    } finally {
      setPushBusy(false);
    }
  };

  const enableQuestionNotifications = async () => {
    if (!pushConfiguration?.ready || !pushConfiguration.publicKey || pushBusy)
      return;
    setPushBusy(true);
    setPushError("");
    let newlyCreatedSubscription: PushSubscription | null = null;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setPushSetupState("denied");
        return;
      }
      await navigator.serviceWorker.register("/service-worker.js");
      const registration = await navigator.serviceWorker.ready;
      const existingSubscription =
        await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ??
        (newlyCreatedSubscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodePushApplicationServerKey(
            pushConfiguration.publicKey,
          ) as BufferSource,
        }));
      await savePushSubscription(subscription);
      setQuestionNotificationsEnabled(true);
      setPushSetupState("ready");
    } catch (error) {
      if (newlyCreatedSubscription)
        await newlyCreatedSubscription.unsubscribe().catch(() => {});
      setPushSetupState("error");
      setPushError(shortError(error));
    } finally {
      setPushBusy(false);
    }
  };

  const disableQuestionNotifications = async () => {
    if (!questionNotificationsEnabled || pushBusy) return;
    setPushBusy(true);
    setPushError("");
    try {
      const subscription = await getCurrentPushSubscription();
      if (!subscription)
        throw new Error(
          "This browser’s notification subscription was not found.",
        );
      const response = await fetch("/api/push/subscription", {
        method: "DELETE",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (!response.ok)
        throw new Error("Could not turn off this device’s notifications.");
      setQuestionNotificationsEnabled(false);
      await subscription.unsubscribe().catch(() => false);
      setPushSetupState("ready");
    } catch (error) {
      setPushSetupState("error");
      setPushError(shortError(error));
    } finally {
      setPushBusy(false);
    }
  };

  useEffect(() => {
    if (!status?.authenticated || !status.daemon.available) {
      detach();
      return;
    }
    attach({
      onNotification: (method, params) =>
        handlersRef.current.onNotification(method, params),
      onServerRequest: (request) =>
        handlersRef.current.onServerRequest(request),
      onDisconnected: () => handlersRef.current.onDisconnected(),
      onReady: (rpc) => handlersRef.current.onReady(rpc),
    });
    return detach;
  }, [attach, detach, status?.authenticated, status?.daemon.available]);

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthBusy(true);
    setAuthError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok)
        throw new Error(
          asString(
            result.error ?? result.message,
            "Could not sign in with that token.",
          ),
        );
      sessionExpiredRef.current = false;
      ++sessionProbeEpochRef.current;
      sessionProbeInFlightRef.current = null;
      sessionProbeLastAtRef.current = 0;
      setToken("");
      await refreshStatus();
    } catch (error) {
      setAuthError(shortError(error));
    } finally {
      setAuthBusy(false);
    }
  };

  const signOut = async () => {
    sessionExpiredRef.current = true;
    ++sessionProbeEpochRef.current;
    sessionProbeInFlightRef.current = null;
    try {
      await fetch("/api/logout", {
        method: "POST",
        credentials: "same-origin",
      });
    } catch {
      setNotice({
        tone: "error",
        text: "The sign-out request could not reach the server.",
      });
    } finally {
      detach();
      ++loadVersionRef.current;
      selectedRef.current = null;
      const newRoute: ConversationRoute = { kind: "new" };
      routeRef.current = newRoute;
      setRoute(newRoute);
      updateThreadTrail([]);
      writeHistoryRoute(newRoute, [], "replace");
      historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;
      setStatus({ authenticated: false, daemon: { available: false } });
      setThreads([]);
      setSelectedThread(null);
      setThreadTokenUsage(null);
      queueLoadVersionRef.current += 1;
      setQueueThreadId(null);
      setQueuedSubmissions([]);
      setQueueLoading(false);
      setQueueError("");
      setQueueExpanded(false);
      setThreadDetails(null);
      setItems([]);
      itemsRef.current = [];
      setLoadingThread(false);
      sessionStorage.removeItem(selectedThreadKey);
    }
  };

  const chooseThread = (thread: ThreadSummary) => {
    threadNavigationRef.current = false;
    navigateToThread(thread.id, [], "push");
  };

  const handleThreadSelectClick = (
    event: React.MouseEvent<HTMLButtonElement>,
    thread: ThreadSummary,
  ) => {
    if (suppressedLongPressClickRef.current?.threadId === thread.id) {
      window.clearTimeout(suppressedLongPressClickRef.current.timer);
      suppressedLongPressClickRef.current = null;
      event.preventDefault();
      return;
    }
    chooseThread(thread);
  };

  const renameThread = (thread: ThreadSummary) => {
    setRenameId(thread.id);
    setRenameValue(thread.name ?? thread.preview.split("\n")[0] ?? "");
  };

  const newConversation = (
    historyMode: "push" | "replace" | "none" = "push",
  ) => {
    const newRoute: ConversationRoute = { kind: "new" };
    if (historyMode !== "none") writeHistoryRoute(newRoute, [], historyMode);
    routeRef.current = newRoute;
    setRoute(newRoute);
    updateThreadTrail([]);
    historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;
    ++loadVersionRef.current;
    threadNavigationRef.current = false;
    selectedRef.current = null;
    setThreadTokenUsage(null);
    queueLoadVersionRef.current += 1;
    setQueueThreadId(null);
    setQueuedSubmissions([]);
    setQueueLoading(false);
    setQueueError("");
    setQueueExpanded(false);
    sessionStorage.removeItem(selectedThreadKey);
    setSelectedThread(null);
    setThreadDetails(null);
    setNewProjectId(selectedThread?.projectId || "");
    setDisabledPluginIds([]);
    setItems([]);
    itemsRef.current = [];
    liveItemsRef.current.clear();
    setItemCursor(null);
    setLoadingThread(false);
    setActiveTurnId(null);
    setTurnActive(false);
    activeTurnSnapshotRef.current = {
      threadId: null,
      turnId: null,
      active: false,
    };
    setApprovalPolicy("");
    setSandboxMode("");
    setCwd(selectedThread?.cwd || threadDetails?.cwd || "");
    setModel(
      (current) =>
        current ||
        models.find((entry) => entry.isDefault)?.model ||
        models[0]?.model ||
        "",
    );
    setEffort(
      (current) =>
        current ||
        models.find((entry) => entry.model === model)?.defaultReasoningEffort ||
        "",
    );
    setMobileSidebarOpen(false);
  };
  newConversationRef.current = newConversation;

  const startNewConversationFromSidebar = useCallback(() => {
    if (archivedThreads) {
      setArchivedThreads(false);
      setThreadCursor(null);
      if (client) void refreshThreads(client, false, false);
    }
    setSidebarSection("chats");
    newConversationRef.current();
  }, [archivedThreads, client, refreshThreads]);

  useEffect(() => {
    const handleLocationChange = () => {
      if (!navigationInitializedRef.current) return;
      const locationKey = `${window.location.href}|${JSON.stringify(window.history.state)}`;
      if (historyHandledRef.current === locationKey) return;
      threadNavigationRef.current = false;
      const parsed = parseRouteHash(window.location.hash);
      if (!parsed.route) {
        const newRoute: ConversationRoute = { kind: "new" };
        writeHistoryRoute(newRoute, [], "replace");
        if (parsed.invalid)
          setNotice({
            tone: "error",
            text: "That conversation link is not valid.",
          });
        newConversationRef.current("none");
        return;
      }
      const state = readHistoryState(
        window.history.state,
        routeHash(parsed.route),
      );
      if (parsed.route.kind === "new") {
        newConversationRef.current("none");
        return;
      }
      navigateToThread(
        parsed.route.threadId,
        state?.threadTrail ?? [],
        "none",
        state?.parentRoute,
      );
    };
    window.addEventListener("popstate", handleLocationChange);
    window.addEventListener("hashchange", handleLocationChange);
    return () => {
      window.removeEventListener("popstate", handleLocationChange);
      window.removeEventListener("hashchange", handleLocationChange);
    };
  }, [navigateToThread]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        startNewConversationFromSidebar();
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        setSidebarSection("chats");
        setSidebarSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [startNewConversationFromSidebar]);

  const loadOlderItems = async () => {
    if (!client || !selectedThread || !itemCursor) return;
    const requestedThreadId = selectedThread.id;
    setLoadingOlderItems(true);
    const view = timelineRef.current;
    const previousHeight = view?.scrollHeight ?? 0;
    const previousTop = view?.scrollTop ?? 0;
    try {
      const page = await client.request<{
        data: ThreadItemEntry[];
        nextCursor: string | null;
      }>("thread/items/list", {
        threadId: requestedThreadId,
        cursor: itemCursor,
        limit: 50,
        sortDirection: "desc",
      });
      if (selectedRef.current !== requestedThreadId) return;
      const older = [...page.data].reverse().map((entry) => ({ ...entry }));
      setItems((current) =>
        mergeHistoryWithLive(
          [...older, ...current],
          current,
          liveItemsRef.current,
        ),
      );
      setItemCursor(page.nextCursor);
      requestAnimationFrame(() => {
        if (!view) return;
        view.scrollTop = view.scrollHeight - previousHeight + previousTop;
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not load earlier messages: ${shortError(error)}`,
      });
    } finally {
      setLoadingOlderItems(false);
    }
  };

  const selectModel = (nextModel: string) => {
    setModel(nextModel);
    const selected = models.find((entry) => entry.model === nextModel);
    if (
      selected &&
      !selected.supportedReasoningEfforts.some(
        (option) => option.reasoningEffort === effort,
      )
    ) {
      setEffort(selected.defaultReasoningEffort);
    }
  };

  const selectedModel = models.find((entry) => entry.model === model);
  const availableEfforts = selectedModel?.supportedReasoningEfforts ?? [];
  const completionCwd =
    cwd.trim() || selectedThread?.cwd || threadDetails?.cwd || "";
  const composerCanComplete =
    Boolean(client) &&
    connection === "online" &&
    !loadingThread &&
    !sending &&
    !queueing &&
    !compactingThreadId &&
    !steeringSubmissionId &&
    selectedThread?.canAcceptDirectInput !== false;
  const filteredThreads = useMemo(() => {
    const query = threadSearch.toLowerCase().trim();
    if (!query) return threads;
    const agentAncestors = agentAncestorIds(subagentThreads, query);
    return threads.filter((thread) =>
      agentAncestors.has(thread.id) ||
      `${titleFor(thread)} ${thread.preview} ${thread.cwd}`
        .toLowerCase()
        .includes(query),
    );
  }, [threadSearch, threads, subagentThreads]);
  const scheduledIndicatorIds = useMemo(() => scheduledThreadIds(scheduledTasksForIndicators), [scheduledTasksForIndicators]);
  const activeChildParentIds = useMemo(() => activeSubagentParents(subagentThreads), [subagentThreads]);
  const pendingDecisionIds = useMemo(() => new Set(approvalQueue.map((prompt) => asString(prompt.params.threadId)).filter(Boolean)), [approvalQueue]);
  const statusForThread = useCallback((thread: ThreadSummary) => threadIndicator(thread, {
    pendingDecision: pendingDecisionIds.has(thread.id),
    activeChild: activeChildParentIds.has(thread.id),
    scheduled: scheduledIndicatorIds.has(thread.id),
    failedTurn: failedThreadIds.has(thread.id),
  }).kind, [pendingDecisionIds,activeChildParentIds,scheduledIndicatorIds,failedThreadIds]);
  const projectGroups: SidebarThreadGroup[] = useMemo(
    () => groupSidebarThreads(filteredThreads,codexProjects,projectPreferences.sort,archivedThreads,
      projectPreferences.view,statusForThread),
    [filteredThreads,codexProjects,projectPreferences.sort,projectPreferences.view,archivedThreads,status?.sidebar,statusForThread],
  );

  useEffect(() => {
    if (sidebarSearchOpen && sidebarSection === "chats")
      sidebarSearchRef.current?.focus();
  }, [sidebarSearchOpen, sidebarSection]);
  const timelineGrouping = useMemo(() => groupTimelineItems(items), [items]);
  // Match by the official clientUserMessageId; this prevents duplicate local
  // and daemon bubbles even when item notifications arrive before the RPC reply.
  const deliveredClientIds=useMemo(()=>new Set(items
    .filter(entry=>entry.item.type==="userMessage"&&typeof entry.item.clientId==="string")
    .map(entry=>entry.item.clientId as string)),[items]);
  const isOptimisticDelivered=(message:OptimisticSubmission)=>
    deliveredClientIds.has(message.id) ||
    (message.kind==="turn" && !!message.turnId && items.some(entry=>
      entry.item.type==="userMessage"&&entry.turnId===message.turnId));
  const visibleOptimistic=optimisticMessages.filter(message=>
    !isOptimisticDelivered(message) &&
    (message.threadId===selectedThread?.id ||
      (message.threadId===null && !selectedThread && route.kind==="new"))
  );
  useEffect(()=>{
    const completedIds=new Set(optimisticMessages.filter(isOptimisticDelivered).map(m=>m.id));
    if(completedIds.size)
      setOptimisticMessages(current=>current.filter(m=>!completedIds.has(m.id)));
  },[items,optimisticMessages]);


  useEffect(() => {
    const requestId = ++completionRequestRef.current;
    const target = completionTarget;
    const canComplete = target !== null && composerCanComplete;
    if (!canComplete || !target || !client) {
      setCompletionItems([]);
      setCompletionLoading(false);
      setCompletionError("");
      return;
    }
    if (target.kind === "command") {
      const query = target.query.toLocaleLowerCase();
      const compactDisabledReason = !selectedThread
        ? "Open a conversation first"
        : turnActive ||
            Boolean(activeTurnId) ||
            selectedThread.status.type === "active"
          ? "Wait for the active turn to finish"
          : undefined;
      setCompletionItems(
        composerCommands
          .filter(({ command }) => command.slice(1).startsWith(query))
          .map(({ command, description }) => ({
            kind: "command" as const,
            command,
            description,
            disabled: command === "/compact" && Boolean(compactDisabledReason),
            disabledReason:
              command === "/compact" ? compactDisabledReason : undefined,
          })),
      );
      setCompletionLoading(false);
      setCompletionError("");
      return;
    }
    setCompletionItems([]);
    setCompletionIndex(0);
    setCompletionLoading(true);
    setCompletionError("");
    let sentFileSearch = false;
    const timer = window.setTimeout(
      () => {
        if (target.kind === "mention") {
          const cacheKey=completionCwd||"__global__";
          const cached=pluginsCacheRef.current.get(cacheKey);
          const loadPlugins=cached
            ? Promise.resolve(cached)
            : client.request<{marketplaces:Array<{plugins:Array<{
                id:string;name:string;installed:boolean;enabled:boolean;
                interface?:{displayName?:string|null;shortDescription?:string|null}|null;
              }>}>}>("plugin/installed",{
                ...(completionCwd?{cwds:[completionCwd]}:{}),
              }).then(response=>{
                const byId=new Map<string,Extract<ComposerCompletionItem,{kind:"plugin"}>>();
                for(const marketplace of response.marketplaces||[])
                  for(const plugin of marketplace.plugins||[]){
                    if(!plugin.installed||!plugin.enabled||!/^[a-zA-Z0-9_.@-]+$/.test(plugin.id))continue;
                    const name=plugin.interface?.displayName?.trim()||plugin.name;
                    byId.set(plugin.id,{
                      kind:"plugin",name,id:plugin.id,
                      description:plugin.interface?.shortDescription||plugin.name,
                    });
                  }
                const list=[...byId.values()].sort((a,b)=>a.name.localeCompare(b.name));
                pluginsCacheRef.current.set(cacheKey,list);
                return list;
              });
          // @ lists installed plugins immediately; @query also searches cwd files.
          const fileRequest=completionCwd&&target.query
            ? (sentFileSearch=true,client.request<{files:FuzzyFileSearchResult[]}>(
                "fuzzyFileSearch",{
                  query:target.query,roots:[completionCwd],
                  cancellationToken:"codex-daemon-web-composer",
                }).then(response=>response.files.slice(0,30).map(file=>({
                  kind:"file" as const,path:file.path,
                  label:file.path.startsWith(file.root+"/")||file.path.startsWith(file.root+"\\")
                    ? file.path.slice(file.root.length+1):file.path,
                  isDirectory:file.match_type==="directory",
                }))).catch(()=>[]))
            : Promise.resolve([] as Extract<ComposerCompletionItem,{kind:"file"}>[]);
          void Promise.allSettled([loadPlugins,fileRequest]).then(results=>{
            if(completionRequestRef.current!==requestId)return;
            const plugins=results[0].status==="fulfilled"?results[0].value:[];
            const files=results[1].status==="fulfilled"?results[1].value:[];
            const query=target.query.toLocaleLowerCase();
            const matching=plugins.filter(plugin=>
              !disabledPluginIds.includes(plugin.id) && (!query||
              plugin.name.toLocaleLowerCase().includes(query)||
              plugin.description.toLocaleLowerCase().includes(query)||
              plugin.id.toLocaleLowerCase().includes(query)));
            setCompletionItems([...matching,...files]);
            if(results[0].status==="rejected"&&!files.length)
              setCompletionError(shortError(results[0].reason));
            setCompletionLoading(false);
          });
          return;
        }

        const cacheKey = completionCwd || "__default__";
        const cachedSkills = skillsCacheRef.current.get(cacheKey);
        const skillsRequest = cachedSkills
          ? Promise.resolve(cachedSkills)
          : client
              .request<SkillsListResponse>("skills/list", {
                ...(completionCwd ? { cwds: [completionCwd] } : {}),
              })
              .then((response) => {
                const skills = response.data
                  .filter(
                    (entry) => !completionCwd || entry.cwd === completionCwd,
                  )
                  .flatMap((entry) => entry.skills)
                  .filter((skill) => skill.enabled);
                skillsCacheRef.current.set(cacheKey, skills);
                return skills;
              });
        void skillsRequest
          .then((skills) => {
            if (completionRequestRef.current !== requestId) return;
            const query = target.query.toLocaleLowerCase();
            setCompletionItems(
              skills
                .filter(
                  (skill) =>
                    !query ||
                    skill.name.toLocaleLowerCase().includes(query) ||
                    skill.description.toLocaleLowerCase().includes(query),
                )
                .map((skill) => ({
                  kind: "skill" as const,
                  name: skill.name,
                  description: skill.description,
                  path: skill.path,
                })),
            );
            setCompletionLoading(false);
          })
          .catch((error: unknown) => {
            if (completionRequestRef.current !== requestId) return;
            setCompletionError(shortError(error));
            setCompletionLoading(false);
          });
      },
      target.kind === "mention" ? 110 : 80,
    );

    return () => {
      window.clearTimeout(timer);
      if (sentFileSearch && client && completionCwd) {
        void client
          .request("fuzzyFileSearch", {
            query: "",
            roots: [completionCwd],
            cancellationToken: "codex-daemon-web-composer",
          })
          .catch(() => {});
      }
      if (completionRequestRef.current === requestId)
        completionRequestRef.current += 1;
    };
  }, [
    client,
    composerCanComplete,
    completionCwd,
    completionTarget?.kind,
    completionTarget?.query,
    connection,
    loadingThread,
    queueing,
    activeTurnId,
    compactingThreadId,
    selectedThread?.canAcceptDirectInput,
    sending,
    skillsRevision,
    disabledPluginIds,
    turnActive,
  ]);

  useEffect(() => {
    setCompletionTarget(null);
    setCompletionItems([]);
  }, [completionCwd, selectedThread?.id]);

  useEffect(() => {
    const selectedSkills = selectedSkillsRef.current;
    selectedSkillsRef.current = selectedSkills.filter((skill) =>
      containsComposerToken(composer, `$${skill.name}`),
    );
  }, [composer]);

  const syncCompletionTarget = (text: string, caret: number) => {
    const target = completionTargetAt(text, caret);
    const dismissed = dismissedCompletionRef.current;
    if (target && dismissed) {
      const token = text.slice(target.start, target.end);
      if (target.kind === dismissed.kind && token === dismissed.token) {
        setCompletionTarget(null);
        return;
      }
      dismissedCompletionRef.current = null;
    }
    setCompletionTarget(target);
  };

  const selectCompletion = (item: ComposerCompletionItem) => {
    if (
      !completionTarget ||
      !client ||
      connection !== "online" ||
      loadingThread ||
      sending ||
      queueing ||
      selectedThread?.canAcceptDirectInput === false
    )
      return;
    if (item.kind === "command" && item.disabled) return;
    const inserted =
      item.kind === "file"
        ? /\s/.test(item.path) && !item.path.includes('"')
          ? `"${item.path}"`
          : item.path
        : item.kind === "skill"
          ? `$${item.name}`
          : item.kind === "plugin"
            ? `[@${item.name.replace(/[\[\]\n\r]/g,"")}](plugin://${item.id})`
            : item.command;
    const suffix = composer.slice(completionTarget.end);
    const hasSeparator = /^\s/u.test(suffix);
    const separator = hasSeparator ? suffix : ` ${suffix}`;
    const caret = completionTarget.start + inserted.length + (hasSeparator?0:1);
    const nextText =
      composer.slice(0, completionTarget.start) + inserted + separator;
    if (item.kind === "skill")
      selectedSkillsRef.current = [
        ...selectedSkillsRef.current,
        { name: item.name, path: item.path },
      ];
    dismissedCompletionRef.current =
      item.kind === "skill" ? { kind: "skill", token: inserted } : null;
    setComposer(nextText);
    setCompletionTarget(null);
    setCompletionItems([]);
    setCompletionIndex(0);
    requestAnimationFrame(() => {
      const textarea = composerRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
      textarea.style.height = "auto";
      textarea.style.height = `${textarea.scrollHeight}px`;
    });
  };

  const handleComposerChange = (text: string, caret: number) => {
    setComposer(text);
    syncCompletionTarget(text, caret);
  };

  const clearComposerText = () => {
    setComposer("");
    if (composerRef.current) composerRef.current.style.height = "39px";
  };
  const beginOptimistic=(message:OptimisticSubmission,sourceText:string)=>{
    setOptimisticMessages(current=>[...current.filter(item=>item.id!==message.id),message]);
    scrollWasNearBottom.current=true;
    // Acknowledge the click visually before waiting for Codex's RPC response.
    if((composerRef.current?.value??sourceText)===sourceText)clearComposerText();
    clearUploadsIfUnchanged(message.attachments);
  };
  const changeOptimistic=(id:string,update:Partial<OptimisticSubmission>)=>{
    setOptimisticMessages(current=>current.map(item=>item.id===id?{...item,...update}:item));
  };
  const restoreOptimistic=async(message:OptimisticSubmission)=>{
    if(message.threadId && client){
      try{
        if(await threadHasClientMessage(client,message.threadId,message.id,itemsRef.current)){
          setOptimisticMessages(current=>current.filter(item=>item.id!==message.id));
          setNotice({tone:"info",text:"Codex already received this message. No retry is needed."});
          return;
        }
        if(message.kind==="queue"){
          const queue=await listThreadQueue(client,message.threadId);
          if(queue.some(entry=>entry.clientUserMessageId===message.id)){
            setOptimisticMessages(current=>current.filter(item=>item.id!==message.id));
            setNotice({tone:"info",text:"This message is already in the queue. No retry is needed."});
            void refreshThreadQueue(client,message.threadId);
            return;
          }
        }
      }catch(error){
        setNotice({tone:"error",text:"Could not check delivery; the draft was not restored. "+shortError(error)});
        return;
      }
    }
    if((message.threadId||null)!==(selectedThread?.id||null)){
      setNotice({tone:"info",text:"Open the original conversation before restoring this draft."});
      return;
    }
    const text=message.input.filter(part=>part.type==="text").map(part=>part.type==="text"?part.text:"").join("\n");
    setComposer(current=>current.trim()?current+"\n"+text:text);
    updateUploads(current=>[...current,...message.attachments.filter(upload=>!current.some(x=>x.id===upload.id))]);
    selectedSkillsRef.current=[...selectedSkillsRef.current,...message.selectedSkills];
    setOptimisticMessages(current=>current.filter(item=>item.id!==message.id));
    setNotice({tone:"info",text:"Draft restored. Verify it was not delivered before sending again."});
    requestAnimationFrame(()=>composerRef.current?.focus());
  };


  const runNewConversationCommand = () => {
    setCompletionTarget(null);
    setCompletionItems([]);
    clearComposerText();
    newConversation();
  };

  const sendMessage = async (
    event?: FormEvent<HTMLFormElement>,
    action: "auto" | "steer" = "auto",
  ) => {
    event?.preventDefault();
    const commandText = composer.trim();
    if (commandText === "/new") {
      runNewConversationCommand();
      return;
    }
    if (commandText === "/compact") {
      setCompletionTarget(null);
      setCompletionItems([]);
      if (compactingThreadRef.current) return;
      if (!client || connection !== "online") {
        setNotice({
          tone: "info",
          text: "Reconnect before compacting this conversation.",
        });
        return;
      }
      if (
        !selectedThread ||
        routeRef.current.kind !== "thread" ||
        selectedRef.current !== selectedThread.id
      ) {
        setNotice({
          tone: "info",
          text: "Open a conversation before compacting its context.",
        });
        return;
      }
      if (selectedThread.canAcceptDirectInput === false) {
        setNotice({
          tone: "info",
          text: "This agent is controlled by its parent.",
        });
        return;
      }
      if (
        loadingThread ||
        sending ||
        queueing ||
        queueingRef.current ||
        queueSteerInFlightRef.current ||
        steeringSubmissionId !== null ||
        compressingUploadsRef.current
      ) {
        setNotice({
          tone: "info",
          text: "Wait for the current conversation action to finish before compacting.",
        });
        return;
      }
      if (
        turnActive ||
        activeTurnId ||
        selectedThread.status.type === "active"
      ) {
        setNotice({
          tone: "info",
          text: "Wait for the active turn to finish before compacting.",
        });
        return;
      }

      const threadId = selectedThread.id;
      const draftAtCommand = composer;
      compactingThreadRef.current = threadId;
      setCompactingThreadId(threadId);
      setNotice({ tone: "info", text: "Starting context compaction…" });
      try {
        await client.request<Record<string, never>>("thread/compact/start", {
          threadId,
        });
        if (selectedRef.current === threadId) {
          if ((composerRef.current?.value ?? draftAtCommand) === draftAtCommand)
            clearComposerText();
          setNotice({ tone: "info", text: "Context compaction started." });
        }
      } catch (error) {
        if (selectedRef.current === threadId)
          setNotice({
            tone: "error",
            text: `Could not start context compaction: ${shortError(error)}`,
          });
      } finally {
        compactingThreadRef.current = null;
        setCompactingThreadId(null);
      }
      return;
    }
    if (isComposerCommandWithArguments(commandText)) {
      setCompletionTarget(null);
      setCompletionItems([]);
      setNotice({
        tone: "info",
        text: "This command does not accept arguments.",
      });
      return;
    }
    if (selectedThread?.canAcceptDirectInput === false) {
      setNotice({
        tone: "info",
        text: "This agent is controlled by its parent.",
      });
      return;
    }
    if (
      sending ||
      queueingRef.current ||
      compactingThreadRef.current ||
      queueSteerInFlightRef.current ||
      compressingUploadsRef.current ||
      (!composer.trim() && uploads.length === 0) ||
      !client ||
      connection !== "online"
    )
      return;
    if (loadingThread || selectedRef.current !== (selectedThread?.id ?? null)) {
      setNotice({
        tone: "info",
        text: "Wait for the selected conversation to finish loading before sending.",
      });
      return;
    }
    const hasActiveTurn = turnActive || Boolean(activeTurnId);
    const shouldSteer = action === "steer" || hasActiveTurn;
    if (shouldSteer && (!selectedThread || !turnActive || !activeTurnId)) {
      setNotice({
        tone: "info",
        text: "Wait for the active turn details before sending a direction.",
      });
      return;
    }
    setSending(true);
    setNotice(null);
    const selectionAtSend = selectedRef.current;
    const loadVersionAtSend = loadVersionRef.current;
    const composerAtSend = composer;
    const uploadsAtSend = [...uploads];
    const selectedSkillsAtSend = [...selectedSkillsRef.current];
    setCompletionTarget(null);
    let threadId = selectedThread?.id;
    const threadIdAtSend = threadId ?? null;
    const turnIdAtSend = activeTurnId;
    let optimisticId:string|null=null;
    try {
      const input = userInputFromDraft(
        composerAtSend,
        uploadsAtSend,
        selectedSkillsAtSend,
      );

      if (shouldSteer) {
        const attemptKey = JSON.stringify([
          threadIdAtSend,
          turnIdAtSend,
          composerAtSend,
          uploadsAtSend.map((upload) => upload.id),
          selectedSkillsAtSend,
        ]);
        const clientUserMessageId =
          steerAttemptRef.current?.key === attemptKey
            ? steerAttemptRef.current.clientUserMessageId
            : clientUUID();
        steerAttemptRef.current = { key: attemptKey, clientUserMessageId };
        const steerParams = {
          threadId: threadIdAtSend!,
          expectedTurnId: turnIdAtSend!,
          clientUserMessageId,
          input,
        };
        const requestBytes = serializedRequestBytes("turn/steer", steerParams);
        if (requestBytes > maxTurnRequestBytes) {
          setNotice({
            tone: "error",
            text: `This direction is too large for Codex (${Math.ceil(requestBytes / 1024)} KB; limit ${Math.floor(maxTurnRequestBytes / 1024)} KB). Remove an image or shorten the text.`,
          });
          return;
        }
        optimisticId=clientUserMessageId;
        beginOptimistic({
          id:clientUserMessageId,threadId:threadIdAtSend,
          kind:"steer",status:"sending",input,
          attachments:uploadsAtSend,selectedSkills:selectedSkillsAtSend,
        },composerAtSend);
        await client.request<{ turnId: string }>("turn/steer", steerParams);
        changeOptimistic(clientUserMessageId,{status:"confirmed"});
        steerAttemptRef.current=null;
        void refreshThreads(client, archivedThreads, false);
        setNotice({
          tone: "success",
          text: "Direction sent to the active turn.",
        });
        return;
      }

      const directMessageId=clientUUID();
      const turnParams: Record<string, unknown> = {
        threadId: threadId ?? "00000000-0000-0000-0000-000000000000",
        disabledPluginIds,
        clientUserMessageId:directMessageId,
        input,
      };
      if (model) turnParams.model = model;
      if (effort) turnParams.effort = effort;
      if (selectedThread && cwd.trim() && cwd !== selectedThread.cwd)
        turnParams.cwd = cwd.trim();
      if (approvalPolicy) turnParams.approvalPolicy = approvalPolicy;
      if (sandboxMode && selectedThread) {
        turnParams.sandboxPolicy = {
          type:
            sandboxMode === "read-only"
              ? "readOnly"
              : sandboxMode === "danger-full-access"
                ? "dangerFullAccess"
                : "workspaceWrite",
          ...(sandboxMode === "read-only" ? { networkAccess: false } : {}),
          ...(sandboxMode === "workspace-write"
            ? {
                writableRoots: [cwd.trim() || selectedThread.cwd || ""],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              }
            : {}),
        };
      }

      const requestBytes = serializedRequestBytes("turn/start", turnParams);
      if (requestBytes > maxTurnRequestBytes) {
        setNotice({
          tone: "error",
          text: `This message is too large for Codex (${Math.ceil(requestBytes / 1024)} KB; limit ${Math.floor(maxTurnRequestBytes / 1024)} KB). Remove an image or shorten the text.`,
        });
        return;
      }

      optimisticId=directMessageId;
      beginOptimistic({
        id:directMessageId,threadId:threadIdAtSend,
        kind:"turn",status:"sending",input,
        attachments:uploadsAtSend,selectedSkills:selectedSkillsAtSend,
      },composerAtSend);

      if (!threadId) {
        const startParams: Record<string, unknown> = {};
        if (model) startParams.model = model;
        if (cwd.trim()) startParams.cwd = cwd.trim();
        if (newProjectId) startParams.projectId = newProjectId;
        if (approvalPolicy) startParams.approvalPolicy = approvalPolicy;
        if (sandboxMode) startParams.sandbox = sandboxMode;
        const started = await client.request<{
          thread: ThreadSummary;
          model: string;
          cwd: string;
        }>("thread/start", startParams);
        if (!archivedThreads)
          setThreads((current) =>
            mergeThreadPage(current, [started.thread], true, true),
          );
        if (
          loadVersionRef.current !== loadVersionAtSend ||
          selectedRef.current !== selectionAtSend ||
          routeRef.current.kind !== "new"
        )
          return;
        threadId = started.thread.id;
        turnParams.threadId = threadId;
        changeOptimistic(directMessageId,{threadId});
        const startedRoute: ConversationRoute = {
          kind: "thread",
          threadId,
        };
        routeRef.current = startedRoute;
        setRoute(startedRoute);
        writeHistoryRoute(startedRoute, [], "push");
        historyHandledRef.current = `${window.location.href}|${JSON.stringify(window.history.state)}`;
        selectedRef.current = threadId;
        setSelectedThread(started.thread);
        setThreadDetails({
          ...started,
          approvalPolicy: approvalPolicy || null,
          sandbox: sandboxMode
            ? {
                type: sandboxMode.replace(/-([a-z])/g, (_, char: string) =>
                  char.toUpperCase(),
                ),
              }
            : null,
          activePermissionProfile: null,
          reasoningEffort: effort || null,
          thread: { status: { type: "idle" } },
        });
        sessionStorage.setItem(selectedThreadKey, threadId);
      }

      const actualRequestBytes = serializedRequestBytes(
        "turn/start",
        turnParams,
      );
      if (actualRequestBytes > maxTurnRequestBytes) {
        setNotice({
          tone: "error",
          text: `This message is too large for Codex (${Math.ceil(actualRequestBytes / 1024)} KB; limit ${Math.floor(maxTurnRequestBytes / 1024)} KB). Remove an image or shorten the text.`,
        });
        return;
      }
      const response = await client.request<{
        turn: { id: string; status: string };
      }>("turn/start", turnParams);
      changeOptimistic(directMessageId,{status:"confirmed",turnId:response.turn.id});
      if (selectedRef.current === threadId) {
        if (response.turn.status === "inProgress")
          eligibleCompletionTurnIdsRef.current.add(response.turn.id);
        setActiveTurnId(response.turn.id);
        setTurnActive(response.turn.status === "inProgress");
        activeTurnSnapshotRef.current = {
          threadId,
          turnId: response.turn.id,
          active: response.turn.status === "inProgress",
        };
        setShowOptions(false);
      }
    } catch (error) {
      if(optimisticId)
        changeOptimistic(optimisticId,{status:"unconfirmed",error:shortError(error)});
      setNotice({
        tone: "error",
        text: shouldSteer
          ? `Could not confirm that the direction was sent. Check the conversation before retrying. ${shortError(error)}`
          : `Could not confirm that Codex started the turn. Check the conversation before retrying. ${shortError(error)}`,
      });
    } finally {
      setSending(false);
    }
  };

  const queueMessage = async () => {
    const commandText = composer.trim();
    if (commandText === "/new") {
      runNewConversationCommand();
      return;
    }
    if (isComposerCommandWithArguments(commandText)) {
      setNotice({
        tone: "info",
        text: "This command does not accept arguments.",
      });
      return;
    }
    if (/^\/(?:new|compact)$/u.test(commandText)) {
      setNotice({
        tone: "info",
        text: "Run this command directly; it cannot be queued as a reply.",
      });
      return;
    }
    if (
      queueingRef.current ||
      queueSteerInFlightRef.current ||
      sending ||
      compactingThreadRef.current ||
      compressingUploadsRef.current
    )
      return;
    if (selectedThread?.canAcceptDirectInput === false) return;
    if (
      !client ||
      connection !== "online" ||
      loadingThread ||
      selectedRef.current !== (selectedThread?.id ?? null)
    )
      return;
    if (!selectedThread || !turnActive || !activeTurnId) {
      setNotice({
        tone: "info",
        text: "Wait for the active turn details before queueing a reply.",
      });
      return;
    }
    if (!composer.trim() && uploads.length === 0) return;

    const threadIdAtQueue = selectedThread.id;
    const threadTitleAtQueue = titleFor(selectedThread);
    const loadVersionAtQueue = loadVersionRef.current;
    const textAtQueue = composer;
    const uploadsAtQueue = [...uploads];
    const selectedSkillsAtQueue = [...selectedSkillsRef.current];
    setCompletionTarget(null);
    const input = userInputFromDraft(
      textAtQueue,
      uploadsAtQueue,
      selectedSkillsAtQueue,
    );
    const attemptKey = JSON.stringify([
      threadIdAtQueue,
      textAtQueue,
      uploadsAtQueue.map((upload) => upload.id),
      selectedSkillsAtQueue,
    ]);
    const clientUserMessageId =
      queueAttemptRef.current?.key === attemptKey
        ? queueAttemptRef.current.clientUserMessageId
        : clientUUID();
    queueAttemptRef.current = { key: attemptKey, clientUserMessageId };
    const params = { threadId: threadIdAtQueue, input, clientUserMessageId };
    const requestBytes = serializedRequestBytes("thread/queue/add", params);
    if (requestBytes > maxTurnRequestBytes) {
      setNotice({
        tone: "error",
        text: `This queued reply is too large for Codex (${Math.ceil(requestBytes / 1024)} KB; limit ${Math.floor(maxTurnRequestBytes / 1024)} KB). Remove an image or shorten the text.`,
      });
      return;
    }

    queueingRef.current = true;
    setQueueing(true);
    setNotice(null);
    beginOptimistic({
      id:clientUserMessageId,threadId:threadIdAtQueue,
      kind:"queue",status:"sending",input,
      attachments:uploadsAtQueue,selectedSkills:selectedSkillsAtQueue,
    },textAtQueue);
    try {
      const result = await client.request<{
        queuedSubmission: QueuedSubmission;
      }>("thread/queue/add", params);
      if (!result.queuedSubmission?.id)
        throw new Error("The daemon did not confirm the queued reply.");
      setOptimisticMessages(current=>current.filter(item=>item.id!==clientUserMessageId));
      if (
        selectedRef.current === threadIdAtQueue &&
        loadVersionRef.current === loadVersionAtQueue
      ) {
        setQueueThreadId(threadIdAtQueue);
        setQueueError("");
        setQueuedSubmissions((current) =>
          current.some(
            (submission) => submission.id === result.queuedSubmission.id,
          )
            ? current
            : [...current, result.queuedSubmission],
        );
        void refreshThreadQueue(client, threadIdAtQueue);
      }
      queueAttemptRef.current = null;
      setNotice({
        tone: "success",
        text: `Reply queued for ${threadTitleAtQueue}. It will run after the active turn.`,
      });
    } catch (error) {
      changeOptimistic(clientUserMessageId,{status:"unconfirmed",error:shortError(error)});
      setNotice({
        tone: "error",
        text: `Could not confirm that the reply was queued. Check the thread queue before retrying. ${shortError(error)}`,
      });
    } finally {
      queueingRef.current = false;
      setQueueing(false);
    }
  };

  const reconcileQueueSteerRecovery = async (lockHeld = false) => {
    const recovery = queueSteerRecoveryRef.current;
    if (!client || !recovery || recovery.threadId !== selectedRef.current)
      return;
    if (queueSteerInFlightRef.current && !lockHeld) return;
    if (!lockHeld) {
      queueSteerInFlightRef.current = true;
      setSteeringSubmissionId(recovery.submission.id);
    }
    try {
      const submissions = await listThreadQueue(client, recovery.threadId);
      if (
        submissions.some(
          (submission) =>
            submission.id === recovery.submission.id ||
            submission.clientUserMessageId ===
              recovery.submission.clientUserMessageId,
        )
      ) {
        saveQueueSteerRecovery(null);
        setNotice({
          tone: "info",
          text: "The message is still queued. No steer was sent.",
        });
        void refreshThreadQueue(client, recovery.threadId);
        return;
      }
      if (
        observedSteerClientIdRef.current ===
          recovery.submission.clientUserMessageId ||
        (await threadHasClientMessage(
          client,
          recovery.threadId,
          recovery.submission.clientUserMessageId,
          itemsRef.current,
        ))
      ) {
        saveQueueSteerRecovery(null);
        setNotice({
          tone: "success",
          text: "The saved message has already started in the conversation.",
        });
        void refreshThreadQueue(client, recovery.threadId);
        return;
      }
      saveQueueSteerRecovery({ ...recovery, status: "unknown" });
      setNotice({
        tone: "info",
        text: "The saved message is absent from the queue and recent history. Review the conversation before restoring it.",
      });
      void refreshThreadQueue(client, recovery.threadId);
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not verify the saved message. It remains available for recovery. ${shortError(error)}`,
      });
    } finally {
      if (!lockHeld) {
        queueSteerInFlightRef.current = false;
        setSteeringSubmissionId(null);
      }
    }
  };

  const restoreQueueSteerRecovery = async (
    allowUnknown = false,
    lockHeld = false,
  ) => {
    const recovery = queueSteerRecoveryRef.current;
    if (!client || !recovery || recovery.threadId !== selectedRef.current)
      return false;
    if (
      allowUnknown &&
      !window.confirm(
        "This queued message may already have been steered. Restoring it could make Codex receive it twice. Restore it anyway?",
      )
    )
      return false;
    if (queueSteerInFlightRef.current && !lockHeld) return false;
    if (!lockHeld) queueSteerInFlightRef.current = true;
    setSteeringSubmissionId(recovery.submission.id);
    const restoring = { ...recovery };
    saveQueueSteerRecovery(restoring);
    try {
      const { positionRestored } = await restoreQueuedSubmission(
        client,
        recovery,
        (restored) =>
          saveQueueSteerRecovery({
            ...restoring,
            restoredSubmissionId: restored.id,
          }),
      );
      saveQueueSteerRecovery(null);
      void refreshThreadQueue(client, recovery.threadId);
      setNotice({
        tone: positionRestored ? "success" : "info",
        text: positionRestored
          ? "The queued message was restored in its original position."
          : "The queued message was restored, but its original position could not be confirmed because the queue changed.",
      });
      return true;
    } catch (error) {
      saveQueueSteerRecovery({
        ...restoring,
        status:
          recovery.status === "restoreFailed" ? "restoreFailed" : "unknown",
        ...(recovery.restoredSubmissionId
          ? { restoredSubmissionId: recovery.restoredSubmissionId }
          : {}),
      });
      setNotice({
        tone: "error",
        text: `Could not restore the queued message. Its saved input is still available here. ${shortError(error)}`,
      });
      void refreshThreadQueue(client, recovery.threadId);
      return false;
    } finally {
      if (!lockHeld) {
        queueSteerInFlightRef.current = false;
        setSteeringSubmissionId(null);
      }
    }
  };

  const steerQueuedSubmission = async (submission: QueuedSubmission) => {
    if (
      queueSteerInFlightRef.current ||
      !client ||
      connection !== "online" ||
      !selectedThread ||
      selectedThread.canAcceptDirectInput === false ||
      loadingThread ||
      selectedRef.current !== selectedThread.id ||
      queueThreadId !== selectedThread.id ||
      queueLoading ||
      queueError ||
      !turnActive ||
      !activeTurnId ||
      !submission.clientUserMessageId
    )
      return;
    if (queueSteerRecoveryRef.current) {
      setNotice({
        tone: "info",
        text: "Resolve the saved queue recovery before steering another message.",
      });
      return;
    }
    const originalPosition = queuedSubmissions.findIndex(
      (entry) => entry.id === submission.id,
    );
    if (originalPosition < 0) {
      setNotice({
        tone: "info",
        text: "That queued message is no longer in the current queue. Refresh the queue and try again.",
      });
      void refreshThreadQueue(client, selectedThread.id);
      return;
    }
    const snapshot = activeTurnSnapshotRef.current;
    if (
      snapshot.threadId !== selectedThread.id ||
      !snapshot.active ||
      !snapshot.turnId
    ) {
      setNotice({
        tone: "info",
        text: "There is no active turn to steer. The message remains queued.",
      });
      return;
    }
    const steerParams = {
      threadId: selectedThread.id,
      expectedTurnId: snapshot.turnId,
      clientUserMessageId: submission.clientUserMessageId,
      input: submission.input,
    };
    const requestBytes = serializedRequestBytes("turn/steer", steerParams);
    if (requestBytes > maxTurnRequestBytes) {
      setNotice({
        tone: "error",
        text: `This queued message is too large to steer (${Math.ceil(requestBytes / 1024)} KB; limit ${Math.floor(maxTurnRequestBytes / 1024)} KB). It remains in the queue.`,
      });
      return;
    }

    const recovery: QueuedSteerRecovery = {
      threadId: selectedThread.id,
      submission,
      originalPosition,
      originalQueueIds: queuedSubmissions.map((entry) => entry.id),
      status: "removing",
    };
    if (!saveQueueSteerRecovery(recovery)) {
      setNotice({
        tone: "error",
        text: "Could not save a local recovery copy, so the queued message was left unchanged.",
      });
      return;
    }
    observedSteerClientIdRef.current = null;
    queueSteerInFlightRef.current = true;
    setSteeringSubmissionId(submission.id);
    setNotice(null);
    try {
      const deleted = await client.request<{ deleted: boolean }>(
        "thread/queue/delete",
        {
          threadId: recovery.threadId,
          queuedSubmissionId: submission.id,
        },
      );
      if (!deleted.deleted) {
        saveQueueSteerRecovery({ ...recovery, status: "unknown" });
        await reconcileQueueSteerRecovery(true);
        return;
      }
      saveQueueSteerRecovery({ ...recovery, status: "steering" });
      const currentTurn = activeTurnSnapshotRef.current;
      if (
        selectedRef.current !== recovery.threadId ||
        currentTurn.threadId !== recovery.threadId ||
        currentTurn.turnId !== snapshot.turnId ||
        !currentTurn.active
      ) {
        const restoreRecord = { ...recovery, status: "restoreFailed" as const };
        saveQueueSteerRecovery(restoreRecord);
        await restoreQueueSteerRecovery(false, true);
        return;
      }
      try {
        const result = await client.request<{ turnId: string }>(
          "turn/steer",
          steerParams,
        );
        if (!result.turnId)
          throw new Error("The daemon did not confirm the steer target turn.");
        saveQueueSteerRecovery(null);
        void refreshThreadQueue(client, recovery.threadId);
        void refreshThreads(client, archivedThreads, false);
        setNotice({
          tone: "success",
          text:
            result.turnId === snapshot.turnId
              ? "The queued message was steered into the active turn."
              : "The queued message was accepted by an active turn with a different ID.",
        });
      } catch (error) {
        const alreadyObserved =
          observedSteerClientIdRef.current === submission.clientUserMessageId;
        const alreadyInHistory = alreadyObserved
          ? true
          : await threadHasClientMessage(
              client,
              recovery.threadId,
              submission.clientUserMessageId,
              itemsRef.current,
            ).catch(() => false);
        if (alreadyInHistory) {
          saveQueueSteerRecovery(null);
          setNotice({
            tone: "success",
            text: "The queued message appeared in the conversation despite the interrupted response.",
          });
          return;
        }
        if (isRecord(error) && typeof error.code === "number") {
          saveQueueSteerRecovery({ ...recovery, status: "restoreFailed" });
          const restored = await restoreQueueSteerRecovery(false, true);
          if (restored)
            setNotice({
              tone: "error",
              text: `Codex rejected the steer. The queued message was restored. ${shortError(error)}`,
            });
          return;
        }
        saveQueueSteerRecovery({ ...recovery, status: "unknown" });
        setNotice({
          tone: "error",
          text: `Could not confirm whether the steer was accepted. The saved message was not requeued to avoid a duplicate. Check status before restoring it. ${shortError(error)}`,
        });
      }
    } catch (error) {
      if (isRecord(error) && typeof error.code === "number") {
        saveQueueSteerRecovery(null);
        setNotice({
          tone: "error",
          text: `Codex rejected removing the queued message; no steer was sent. ${shortError(error)}`,
        });
      } else {
        saveQueueSteerRecovery({ ...recovery, status: "unknown" });
        setNotice({
          tone: "error",
          text: `Could not confirm removal from the queue. No steer was sent. Check status before retrying. ${shortError(error)}`,
        });
      }
      void refreshThreadQueue(client, recovery.threadId);
    } finally {
      queueSteerInFlightRef.current = false;
      setSteeringSubmissionId(null);
    }
  };

  const interruptTurn = async () => {
    if (
      !client ||
      !selectedThread ||
      connection !== "online" ||
      loadingThread ||
      sending ||
      queueingRef.current ||
      selectedRef.current !== selectedThread.id ||
      selectedThread.canAcceptDirectInput === false ||
      !activeTurnId ||
      interrupting
    )
      return;
    setInterrupting(true);
    try {
      await client.request("turn/interrupt", {
        threadId: selectedThread.id,
        turnId: activeTurnId,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not interrupt the turn: ${shortError(error)}`,
      });
    } finally {
      setInterrupting(false);
    }
  };

  const preserveComposerFocusOnPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (document.activeElement === composerRef.current) event.preventDefault();
  };

  const openThreadContextMenu = (
    thread: ThreadSummary,
    x: number,
    y: number,
    invoker: HTMLButtonElement | null,
  ) => {
    const menuWidth = 190;
    const menuHeight = 96;
    threadContextMenuInvokerRef.current = invoker;
    setThreadContextMenu({
      thread,
      left: Math.max(8, Math.min(x, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - menuHeight - 8)),
    });
  };

  const clearThreadLongPress = () => {
    if (threadLongPressRef.current)
      window.clearTimeout(threadLongPressRef.current.timer);
    threadLongPressRef.current = null;
  };

  const suppressLongPressClick = (threadId: string) => {
    if (suppressedLongPressClickRef.current)
      window.clearTimeout(suppressedLongPressClickRef.current.timer);
    const timer = window.setTimeout(() => {
      suppressedLongPressClickRef.current = null;
    }, 1200);
    suppressedLongPressClickRef.current = { threadId, timer };
  };

  const handleThreadPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    thread: ThreadSummary,
  ) => {
    if (event.pointerType !== "touch") return;
    clearThreadLongPress();
    const target = event.currentTarget;
    const startX = event.clientX;
    const startY = event.clientY;
    const timer = window.setTimeout(() => {
      threadLongPressRef.current = null;
      suppressLongPressClick(thread.id);
      openThreadContextMenu(thread, startX, startY, target);
    }, 550);
    threadLongPressRef.current = { thread, target, startX, startY, timer };
  };

  const handleThreadPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const press = threadLongPressRef.current;
    if (
      press &&
      (Math.abs(event.clientX - press.startX) > 12 ||
        Math.abs(event.clientY - press.startY) > 12)
    )
      clearThreadLongPress();
  };

  const handleThreadContextMenu = (
    event: React.MouseEvent<HTMLButtonElement>,
    thread: ThreadSummary,
  ) => {
    event.preventDefault();
    const press = threadLongPressRef.current;
    if (press?.thread.id === thread.id) {
      clearThreadLongPress();
      suppressLongPressClick(thread.id);
    }
    openThreadContextMenu(
      thread,
      event.clientX,
      event.clientY,
      event.currentTarget,
    );
  };

  useEffect(() => {
    if (!threadContextMenu) return;
    const frame = window.requestAnimationFrame(() =>
      threadContextMenuFirstActionRef.current?.focus(),
    );
    const handlePointerDown = (event: PointerEvent) => {
      if (!threadContextMenuRef.current?.contains(event.target as Node))
        setThreadContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setThreadContextMenu(null);
        threadContextMenuInvokerRef.current?.focus();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const items =
        threadContextMenuRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="menuitem"]',
        );
      if (!items?.length) return;
      event.preventDefault();
      const currentIndex = Array.from(items).indexOf(
        document.activeElement as HTMLButtonElement,
      );
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? items.length - 1
            : (currentIndex +
                (event.key === "ArrowDown" ? 1 : -1) +
                items.length) %
              items.length;
      items[nextIndex]?.focus();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [threadContextMenu]);

  useEffect(
    () => () => {
      if (threadLongPressRef.current)
        window.clearTimeout(threadLongPressRef.current.timer);
      if (suppressedLongPressClickRef.current)
        window.clearTimeout(suppressedLongPressClickRef.current.timer);
    },
    [],
  );

  const archiveThread = async (thread: ThreadSummary) => {
    if (!client || archiveMutationBusy) return;
    // Never mutate the archive state on the first click: all archive entry
    // points (sidebar row and context menu, including subagents) use this.
    if (!archivedThreads) {
      setArchiveConfirmThread(thread);
      return;
    }
    try {
      await client.request("thread/unarchive",{threadId:thread.id});
      setThreads(current=>current.filter(entry=>entry.id!==thread.id));
      if(selectedThread?.id===thread.id)newConversation();
      setNotice({tone:"success",text:"Conversation restored."});
    }catch(error){
      setNotice({tone:"error",text:`Could not restore conversation: ${shortError(error)}`});
    }
  };

  const confirmArchiveThread = async () => {
    const thread=archiveConfirmThread;
    if(!client||!thread||archiveMutationBusy)return;
    setArchiveMutationBusy(true);
    try{
      await client.request("thread/archive",{threadId:thread.id});
      setArchiveConfirmThread(null);
      setThreads(current=>current.filter(entry=>entry.id!==thread.id));
      if(selectedThread?.id===thread.id)newConversation();
      setNotice({tone:"success",text:"Conversation archived."});
    }catch(error){
      setNotice({tone:"error",text:`Could not archive conversation: ${shortError(error)}`});
    }finally{
      setArchiveMutationBusy(false);
    }
  };

  const saveRename = async (threadId: string) => {
    if (!client) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      const response = await client.request<unknown>("thread/name/set", {
        threadId,
        name,
      });
      const returnedName = isRecord(response)
        ? typeof response.name === "string"
          ? response.name
          : isRecord(response.thread)
            ? asString(response.thread.name)
            : ""
        : "";
      applyThreadName(threadId, returnedName.trim() || name);
      setRenameId((current) => (current === threadId ? null : current));
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not rename conversation: ${shortError(error)}`,
      });
    }
  };

  const addImages = async (files: FileList | File[] | null) => {
    if (!files?.length) return;
    const blockedReason = compressingUploadsRef.current
      ? "Wait for the current image to finish processing before adding another."
      : compactingThreadRef.current
        ? "Wait for context compaction to finish before adding an image."
        : sending || queueingRef.current
          ? "Wait for the current message to finish before adding an image."
          : connection !== "online"
            ? "Connect to Codex before adding an image."
            : loadingThread ||
                selectedRef.current !== (selectedThread?.id ?? null)
              ? "Wait for the selected conversation to finish loading before adding an image."
              : selectedThread?.canAcceptDirectInput === false
                ? "This agent is controlled by its parent and cannot accept images."
                : null;
    if (blockedReason) {
      setNotice({ tone: "error", text: blockedReason });
      return;
    }
    const accepted = Array.from(files).filter((file) =>
      file.type.startsWith("image/"),
    );
    if (!accepted.length) {
      setNotice({ tone: "error", text: "Choose an image file to attach." });
      return;
    }
    if (uploads.length + accepted.length > maxImageCount) {
      setNotice({
        tone: "error",
        text: `Attach up to ${maxImageCount} images to one message.`,
      });
      return;
    }
    const tooLarge = accepted.find((file) => file.size > maxImageFileBytes);
    if (tooLarge) {
      setNotice({
        tone: "error",
        text: `${tooLarge.name} is over the 20 MB input limit.`,
      });
      return;
    }
    compressingUploadsRef.current = true;
    setCompressingUploads(true);
    try {
      const converted: PendingUpload[] = [];
      for (const file of accepted) {
        converted.push({
          id: clientUUID(),
          name: file.name || "Pasted image",
          dataUrl: await compressImage(file),
          size: file.size,
        });
      }
      const combined = [...uploads, ...converted];
      const attachmentBytes = combined.reduce(
        (total, upload) =>
          total + new TextEncoder().encode(upload.dataUrl).byteLength,
        0,
      );
      if (attachmentBytes > maxAttachmentBytes) {
        setNotice({
          tone: "error",
          text: "These compressed images exceed the 700 KB combined attachment limit. Remove an image or choose fewer images.",
        });
        return;
      }
      updateUploads(combined);
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "error", text: shortError(error) });
    } finally {
      compressingUploadsRef.current = false;
      setCompressingUploads(false);
    }
  };

  const handleComposerPaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const clipboard = event.clipboardData;
    const pasted = imagesFromClipboard(clipboard);
    if (!pasted.containsImage) return;

    event.preventDefault();
    const text = textFromClipboardWithImages(clipboard);
    if (text) {
      const textarea = event.currentTarget;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const nextComposer = `${composer.slice(0, start)}${text}${composer.slice(end)}`;
      const caret = start + text.length;
      setComposer(nextComposer);
      requestAnimationFrame(() => {
        textarea.setSelectionRange(caret, caret);
        textarea.style.height = "auto";
        textarea.style.height = `${textarea.scrollHeight}px`;
      });
    }

    if (!pasted.files.length) {
      setNotice({
        tone: "error",
        text: "Could not read the pasted image. Try copying it again or use Attach image.",
      });
      return;
    }
    void addImages(pasted.files);
  };

  const replyApproval = (prompt: ApprovalPrompt, result: unknown) => {
    if (!client) return;
    client.respond(prompt.id, result);
    setApprovalQueue((current) =>
      current.filter((entry) => entry.id !== prompt.id),
    );
    setQuestionAnswers({});
  };

  const rejectUnknownRequest = (prompt: ApprovalPrompt) => {
    if (!client) return;
    const error: RpcError = {
      code: -32601,
      message: "This web client declined an unsupported server request.",
    };
    client.reject(prompt.id, error);
    setApprovalQueue((current) =>
      current.filter((entry) => entry.id !== prompt.id),
    );
  };

  useEffect(() => {
    const view = timelineRef.current;
    if (!view) return;
    if (scrollWasNearBottom.current) view.scrollTop = view.scrollHeight;
  }, [items,visibleOptimistic.length]);

  if (booting) return <LoadingScreen label="Connecting your workspace" />;
  if (!status && statusError) {
    return (
      <UnavailableScreen
        message={statusError}
        retry={() => void refreshStatus()}
      />
    );
  }
  if (!status?.authenticated) {
    return (
      <LoginScreen
        token={token}
        setToken={setToken}
        busy={authBusy}
        error={authError || statusError}
        onSubmit={signIn}
        language={interfaceLanguage}
        setLanguage={setInterfaceLanguageChoice}
      />
    );
  }
  const selectedTitle = selectedThread
    ? titleFor(selectedThread)
    : "New conversation";
  const parentThread = threadTrail.at(-1);
  const currentConnection = status.daemon.available ? connection : "offline";
  const hasComposerContent = Boolean(composer.trim() || uploads.length);
  const hasActiveTurn = turnActive || Boolean(activeTurnId);
  const canCompose =
    connection === "online" &&
    !sending &&
    !queueing &&
    !compactingThreadId &&
    selectedThread?.canAcceptDirectInput !== false &&
    !loadingThread &&
    !compressingUploads &&
    selectedRef.current === (selectedThread?.id ?? null) &&
    hasComposerContent;
  const canSubmit = canCompose && !hasActiveTurn;
  const canSteerOrQueue =
    connection === "online" &&
    selectedThread?.canAcceptDirectInput !== false &&
    !loadingThread &&
    !compressingUploads &&
    selectedRef.current === (selectedThread?.id ?? null) &&
    hasComposerContent &&
    !steeringSubmissionId &&
    Boolean(selectedThread && turnActive && activeTurnId);
  const selectedQueueRecovery =
    queueSteerRecovery?.threadId === selectedThread?.id
      ? queueSteerRecovery
      : null;
  const canSteerQueuedMessage = Boolean(
    connection === "online" &&
    selectedThread &&
    selectedThread.canAcceptDirectInput !== false &&
    !loadingThread &&
    selectedRef.current === selectedThread.id &&
    queueThreadId === selectedThread.id &&
    !queueLoading &&
    !queueError &&
    turnActive &&
    activeTurnId &&
    !steeringSubmissionId &&
    !queueSteerRecovery,
  );
  const queueSteerUnavailableReason =
    selectedThread?.canAcceptDirectInput === false
      ? "This agent is controlled by its parent."
      : connection !== "online"
        ? "Reconnect before steering a queued message."
        : loadingThread
          ? "Wait for the conversation to finish loading."
          : queueLoading || queueError
            ? "Refresh the queue before steering a saved message."
            : !turnActive || !activeTurnId
              ? "Steer now is available only while this thread has an active turn."
              : queueSteerRecovery
                ? "Resolve the saved queue recovery before steering another message."
                : "Steer now is unavailable for this thread.";

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div
        className={`mobile-scrim ${mobileSidebarOpen ? "visible" : ""}`}
        onClick={() => setMobileSidebarOpen(false)}
      />
      <aside
        className={`sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}
        aria-label="Sidebar"
      >
        <div className="sidebar-top" role="group" aria-label="Sidebar actions">
          <button
            className="icon-button sidebar-hide"
            aria-label={
              mobileSidebarOpen ? "Close sidebar" : "Collapse sidebar"
            }
            title={mobileSidebarOpen ? "Close sidebar" : "Collapse sidebar"}
            onClick={() =>
              mobileSidebarOpen
                ? setMobileSidebarOpen(false)
                : setSidebarCollapsed(true)
            }
          >
            <PanelLeftClose size={17} />
          </button>
          <div className="sidebar-top-actions">
            <button
              type="button"
              className="icon-button sidebar-action"
              aria-label={
                sidebarSearchOpen && sidebarSection === "chats"
                  ? "Close conversation search"
                  : "Search conversations"
              }
              title="Search conversations"
              aria-pressed={sidebarSearchOpen && sidebarSection === "chats"}
              onClick={() => {
                const closeSearch =
                  sidebarSection === "chats" && sidebarSearchOpen;
                setSidebarSection("chats");
                if (closeSearch) {
                  setThreadSearch("");
                  setSidebarSearchOpen(false);
                } else {
                  setSidebarSearchOpen(true);
                }
              }}
            >
              <Search size={17} />
            </button>
            <button
              type="button"
              className={`icon-button sidebar-action ${sidebarSection === "tasks" ? "active" : ""}`}
              aria-label={`Scheduled tasks${scheduleCount ? `, ${scheduleCount} active or paused` : ""}`}
              title={`Scheduled tasks${scheduleCount ? ` (${scheduleCount})` : ""}`}
              aria-pressed={sidebarSection === "tasks"}
              onClick={() =>
                setSidebarSection((current) =>
                  current === "tasks" ? "chats" : "tasks",
                )
              }
            >
              <Clock3 size={17} />
              {scheduleCount > 0 ? (
                <span className="sidebar-count-badge" aria-hidden="true">
                  {scheduleCount > 99 ? "99+" : scheduleCount}
                </span>
              ) : null}
            </button>
            <button
              type="button"
              className="icon-button sidebar-action"
              aria-label="New conversation"
              title="New conversation"
              onClick={startNewConversationFromSidebar}
            >
              <Plus size={18} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <ScheduledTasks
          currentThread={selectedThread}
          projectCwd={cwd || selectedThread?.cwd || ""}
          models={models}
          visible={sidebarSection === "tasks"}
          onCountChange={setScheduleCount}
          onTasksChange={setScheduledTasksForIndicators}
          onOpenThread={(threadId) => navigateToThread(threadId, [], "push")}
        />

        {sidebarSearchOpen && sidebarSection === "chats" ? (
          <label className="search-box">
            <span className="sr-only">Search conversations</span>
            <Search size={14} aria-hidden="true" />
            <input
              ref={sidebarSearchRef}
              value={threadSearch}
              onChange={(event) => setThreadSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setThreadSearch("");
                  setSidebarSearchOpen(false);
                }
              }}
              placeholder="Find a conversation"
            />
          </label>
        ) : null}

        <div className="thread-list" hidden={sidebarSection !== "chats"}>
          {archivedThreads ? (
            <div className="history-heading">
              <strong>Archived conversations</strong>
              <button
                type="button"
                onClick={() => {
                  setArchivedThreads(false);
                  setThreadCursor(null);
                  if (client) void refreshThreads(client, false, false);
                }}
              >
                Recent
              </button>
            </div>
          ) : null}
          <label className="project-sort">
            <span>View</span>
            <select aria-label="Conversation list view"
              value={projectPreferences.view}
              onChange={(event)=>setProjectPreferences(current=>({
                ...current, view: event.target.value==="status"?"status":"projects",
              }))}>
              <option value="projects">Projects</option>
              <option value="status">Work status</option>
            </select>
          </label>
          {projectPreferences.view === "projects" ? <label className="project-sort">
            <span>Sort</span>
            <select
              aria-label="Sort projects"
              value={projectPreferences.sort}
              onChange={(event) => setProjectPreferences((current) => ({
                ...current, sort: event.target.value as ProjectSort,
              }))}
            >
              <option value="recent">Recent activity</option>
              <option value="name">Project name</option>
            </select>
          </label> : null}
          {!archivedThreads ? (
            <button type="button" className="project-create-trigger" onClick={openProjectCreate}>
              <Plus size={14} aria-hidden="true" />
              <span>New project</span>
            </button>
          ) : null}
          <div className="thread-status-legend" aria-label="Conversation status legend">
            {threadStatusOrder.filter((kind) => threadStatusPreferences[kind].enabled).map((kind) => (
              <span key={kind}>
                <i className="thread-status-indicator" style={{
                  backgroundColor: threadStatusPreferences[kind].color,
                  borderRadius: threadStatusPreferences[kind].shape === "circle" ? "50%" : "2px",
                }} />{threadStatusLabels[kind]}
              </span>
            ))}
          </div>
          {filteredThreads.length === 0 ? (
            <div className="thread-list-empty">
              {threadSearch
                ? "No matching conversations"
                : archivedThreads
                  ? "No archived conversations"
                  : "Your recent work will appear here"}
            </div>
          ) : (
            projectGroups.map((group) => {
              const expanded = Boolean(threadSearch.trim()) || !projectPreferences.collapsed[group.cwd];
              return (
                <section className="project-group" key={group.cwd} aria-label={group.cwd || "No project"}>
                  <div className="project-heading">
                    {projectRenameId && group.projectId === projectRenameId ? (
                      <form className="project-rename-form"
                        onSubmit={(event)=>{event.preventDefault();void renameCodexProject(projectRenameId);}}>
                        <input autoFocus aria-label="New project name" value={projectRenameValue}
                          disabled={projectMutationBusy}
                          onChange={(event)=>setProjectRenameValue(event.target.value)}
                          onKeyDown={(event)=>{if(event.key==="Escape")setProjectRenameId(null);}} />
                        <button type="submit" disabled={projectMutationBusy||!projectRenameValue.trim()}
                          aria-label="Save project name"><Check size={14}/></button>
                        <button type="button" aria-label="Cancel rename" onClick={()=>setProjectRenameId(null)}><X size={14}/></button>
                      </form>
                    ) : (
                      <>
                        <button type="button" className="project-heading-toggle"
                          aria-expanded={expanded}
                          title={group.path}
                          onClick={()=>setProjectPreferences(current=>({
                            ...current,collapsed:{...current.collapsed,[group.cwd]:!current.collapsed[group.cwd]},
                          }))}>
                          {expanded ? <ChevronDown size={14} aria-hidden="true"/> : <ChevronRight size={14} aria-hidden="true"/>}
                          <span className="project-heading-copy">
                            <strong>{group.name}</strong>
                            <span className="project-path">{group.path}</span>
                          </span>
                          <span className="project-thread-count" aria-label={`${group.threads.length} loaded conversations`}>{group.threads.length}</span>
                        </button>
                        {group.projectId ? <button type="button" className="project-heading-edit"
                          title={`Rename project ${group.name}`} aria-label={`Rename project ${group.name}`}
                          onClick={()=>{setProjectRenameId(group.projectId);setProjectRenameValue(group.name);}}>
                          <Pencil size={13}/>
                        </button> : null}
                      </>
                    )}
                  </div>
                  {expanded ? <div className="project-conversations">
                    {buildAgentTreeRows(group.threads, subagentThreads, collapsedSubagents, archivedThreads, threadSearch.toLowerCase().trim()).map(({thread, depth, childCount, expanded: agentExpanded}) => {
                      const activityTimestamp = threadActivityTimestamp(
                        thread,
                        archivedThreads,
                      );
                      const activityTime = formatThreadActivityTime(activityTimestamp);
                      return (
                        <div
                          key={thread.id}
                          className={`thread-row ${selectedThread?.id === thread.id ? "selected" : ""} ${depth ? "thread-agent-row" : ""}`}
                          style={{ paddingLeft: Math.min(depth, 8) * 13 }}
                        >
                          {childCount ? (
                            <button
                              type="button"
                              className="thread-tree-toggle"
                              aria-expanded={agentExpanded}
                              aria-label={`${agentExpanded ? "Collapse" : "Expand"} ${childCount} subagents`}
                              title={`${childCount} subagents`}
                              onClick={() => setCollapsedSubagents((current) => ({ ...current, [thread.id]: !current[thread.id] }))}
                            >
                              {agentExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                            </button>
                          ) : <span className="thread-tree-spacer" aria-hidden="true" />}

                          {renameId === thread.id ? (
                            <form
                              className="rename-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void saveRename(thread.id);
                              }}
                            >
                              <input
                                autoFocus
                                value={renameValue}
                                onChange={(event) => setRenameValue(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Escape") setRenameId(null);
                                }}
                                aria-label="Conversation name"
                              />
                              <button aria-label="Save name">
                                <Check size={15} />
                              </button>
                            </form>
                          ) : (
                            <>
                              <button
                                className="thread-select"
                                aria-haspopup="menu"
                                aria-expanded={
                                  threadContextMenu?.thread.id === thread.id
                                }
                                title="Right-click or long-press for conversation actions"
                                onClick={(event) => {
                                  handleThreadSelectClick(event, thread);
                                }}
                                onDoubleClick={(event) => {
                                  event.preventDefault();
                                  renameThread(thread);
                                }}
                                onContextMenu={(event) =>
                                  handleThreadContextMenu(event, thread)
                                }
                                onKeyDown={(event) => {
                                  if (
                                    event.key !== "ContextMenu" &&
                                    !(event.shiftKey && event.key === "F10")
                                  )
                                    return;
                                  event.preventDefault();
                                  const bounds =
                                    event.currentTarget.getBoundingClientRect();
                                  openThreadContextMenu(
                                    thread,
                                    bounds.left + 12,
                                    bounds.bottom,
                                    event.currentTarget,
                                  );
                                }}
                                onPointerDown={(event) =>
                                  handleThreadPointerDown(event, thread)
                                }
                                onPointerMove={handleThreadPointerMove}
                                onPointerUp={clearThreadLongPress}
                                onPointerCancel={clearThreadLongPress}
                              >
                                {(() => {
                                  const indicator = threadIndicator(thread, {
                                    pendingDecision: pendingDecisionIds.has(thread.id),
                                    activeChild: activeChildParentIds.has(thread.id),
                                    scheduled: scheduledIndicatorIds.has(thread.id),
                                    failedTurn: failedThreadIds.has(thread.id),
                                  });
                                  const marker = threadStatusPreferences[indicator.kind];
                                  return marker.enabled ? <span
                                    className={`thread-status-indicator thread-status-${indicator.kind}`}
                                    style={{backgroundColor: marker.color, borderRadius: marker.shape === "circle" ? "50%" : "2px"}}
                                    title={indicator.label}
                                    aria-label={indicator.label}
                                    role="img"
                                  /> : null;
                                })()}
                                <span className="thread-copy">
                                  <span className="thread-name">
                                    {depth > 0 ? `Agent · ${agentDisplayName(thread) || titleFor(thread)}` : titleFor(thread)}
                                  </span>
                                  <span className="thread-subtitle">
                                    {activityTime ? (
                                      <time
                                        dateTime={new Date(
                                          activityTimestamp!,
                                        ).toISOString()}
                                      >
                                        {activityTime}
                                      </time>
                                    ) : null}
                                    {thread.cwd ? (
                                      <span
                                        className="thread-project"
                                        title={thread.cwd}
                                      >
                                        {projectNameFor(thread.cwd)}
                                      </span>
                                    ) : null}
                                  </span>
                                </span>
                              </button>
                            </>
                          )}
                          {renameId !== thread.id ? (
                            <button type="button" className="thread-row-action"
                              aria-label={`Copy Codex thread reference for ${titleFor(thread)}`}
                              title="Copy Codex thread reference"
                              onClick={event=>{event.stopPropagation();void copyConversationLink(thread.id);}}>
                              <Link2 size={13} aria-hidden="true"/>
                            </button>
                          ) : null}
                          {renameId !== thread.id ? (
                            <button
                              type="button"
                              className="thread-row-action"
                              aria-label={
                                archivedThreads
                                  ? "Restore conversation"
                                  : "Archive conversation"
                              }
                              title={archivedThreads ? "Restore" : "Archive"}
                              onClick={(event) => {
                                event.stopPropagation();
                                void archiveThread(thread);
                              }}
                            >
                              <Archive size={13} aria-hidden="true" />
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div> : null}
                </section>
              );
            })
          )}
          {threadCursor && (
            <button
              className="load-more-threads"
              onClick={() =>
                client && void refreshThreads(client, archivedThreads, true)
              }
            >
              Load more
            </button>
          )}
        </div>

        <div className="sidebar-footer">
          <div className="sidebar-footer-row">
            <div
              className={`daemon-state ${currentConnection}`}
              role="status"
              aria-live="polite"
            >
              <div className="daemon-state-main">
                <span className="status-dot" />
                <span>{statusLabel(currentConnection)}</span>
              </div>
              <SidebarQuota rpc={client} online={connection==="online"} />
            </div>
            <button
              type="button"
              className="icon-button sidebar-settings"
              aria-label="Settings"
              title="Settings"
              onClick={() => { setShowOptions(false); setShowSettings(true); }}
            >
              <Settings size={17} />
            </button>
          </div>
        </div>
      </aside>

      {threadContextMenu
        ? createPortal(
            <div
              ref={threadContextMenuRef}
              className="thread-context-menu"
              role="menu"
              aria-label={`${titleFor(threadContextMenu.thread)} actions`}
              style={{
                left: threadContextMenu.left,
                top: threadContextMenu.top,
              }}
              onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node))
                  setThreadContextMenu(null);
              }}
            >
              <button
                ref={threadContextMenuFirstActionRef}
                type="button"
                role="menuitem"
                onClick={() => {
                  setRenameId(threadContextMenu.thread.id);
                  setRenameValue(
                    threadContextMenu.thread.name ??
                      threadContextMenu.thread.preview.split("\n")[0] ??
                      "",
                  );
                  setThreadContextMenu(null);
                }}
              >
                <Pencil size={14} aria-hidden="true" />
                <span>Rename</span>
              </button>
              <button type="button" role="menuitem"
                onClick={()=>{
                  const {thread}=threadContextMenu;
                  setThreadContextMenu(null);
                  setProjectMoveThread(thread);
                  setProjectMoveTarget(thread.projectId || "");
                }}>
                <FolderInput size={14} aria-hidden="true"/>
                <span>Move to project…</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { thread } = threadContextMenu;
                  setThreadContextMenu(null);
                  void archiveThread(thread);
                }}
              >
                <Archive size={14} aria-hidden="true" />
                <span>{archivedThreads ? "Restore" : "Archive"}</span>
              </button>
            </div>,
            document.body,
          )
        : null}

      {archiveConfirmThread ? createPortal(
        <div className="modal-scrim settings-scrim"
          onClick={()=>{if(!archiveMutationBusy)setArchiveConfirmThread(null);}}>
          <div className="project-move-panel" role="alertdialog" aria-modal="true"
            aria-labelledby="archive-confirm-title" aria-describedby="archive-confirm-description"
            onClick={event=>event.stopPropagation()}
            onKeyDown={event=>{if(event.key==="Escape"&&!archiveMutationBusy)setArchiveConfirmThread(null);}}>
            <h3 id="archive-confirm-title">Archive conversation?</h3>
            <p title={archiveConfirmThread.name||archiveConfirmThread.preview}>
              {archiveConfirmThread.parentThreadId ? "Subagent · " : ""}
              {archiveConfirmThread.agentNickname||titleFor(archiveConfirmThread)}
            </p>
            <small id="archive-confirm-description">
              This conversation will disappear from the active list. You can restore it from Archived conversations.
            </small>
            <div className="project-move-actions">
              <button type="button" autoFocus disabled={archiveMutationBusy}
                onClick={()=>setArchiveConfirmThread(null)}>Cancel</button>
              <button type="button" disabled={archiveMutationBusy}
                onClick={()=>void confirmArchiveThread()}>
                {archiveMutationBusy?"Archiving…":"Confirm archive"}
              </button>
            </div>
          </div>
        </div>,document.body
      ):null}

      {projectCreateOpen ? createPortal(
        <div className="modal-scrim settings-scrim"
          onClick={()=>!projectMutationBusy&&setProjectCreateOpen(false)}>
          <form className="project-move-panel project-create-panel" role="dialog" aria-modal="true"
            aria-labelledby="project-create-title"
            onClick={event=>event.stopPropagation()}
            onSubmit={event=>{event.preventDefault();void createCodexProject();}}
            onKeyDown={event=>{if(event.key==="Escape"&&!projectMutationBusy)setProjectCreateOpen(false);}}>
            <h3 id="project-create-title">Create Codex project</h3>
            <label htmlFor="project-create-name">Project name</label>
            <input id="project-create-name" autoFocus required maxLength={120}
              value={projectCreateName} disabled={projectMutationBusy}
              onChange={event=>setProjectCreateName(event.target.value)}
              placeholder="e.g. Research project" />
            <label htmlFor="project-create-root">Project root directory</label>
            <input id="project-create-root" required autoCapitalize="off" autoCorrect="off"
              spellCheck={false} value={projectCreateRoot} disabled={projectMutationBusy}
              onChange={event=>setProjectCreateRoot(event.target.value)}
              placeholder="/absolute/path/on/codex-host" />
            <small>Enter an absolute directory path on the Codex host. This registers the root with Codex; it does not create or move files.</small>
            <div className="project-move-actions">
              <button type="button" disabled={projectMutationBusy}
                onClick={()=>setProjectCreateOpen(false)}>Cancel</button>
              <button type="submit" disabled={projectMutationBusy||!projectCreateName.trim()||!projectCreateRoot.trim()}>
                {projectMutationBusy?"Creating…":"Create project"}
              </button>
            </div>
          </form>
        </div>,document.body
      ):null}

      {projectMoveThread ? createPortal(
        <div className="modal-scrim settings-scrim" onClick={()=>!projectMutationBusy&&setProjectMoveThread(null)}>
          <form className="project-move-panel" role="dialog" aria-modal="true"
            aria-labelledby="project-move-title"
            onClick={(event)=>event.stopPropagation()}
            onSubmit={(event)=>{event.preventDefault();void moveConversationToProject();}}
            onKeyDown={(event)=>{if(event.key==="Escape"&&!projectMutationBusy)setProjectMoveThread(null);}}>
            <h3 id="project-move-title">Move conversation</h3>
            <p title={titleFor(projectMoveThread)}>{titleFor(projectMoveThread)}</p>
            <label htmlFor="project-move-target">Destination project</label>
            <select id="project-move-target" value={projectMoveTarget} disabled={projectMutationBusy}
              onChange={(event)=>setProjectMoveTarget(event.target.value)}>
              <option value="">No project (remove from project)</option>
              {codexProjects.map(project=>(
                <option value={project.id} key={project.id}>{projectOptionLabel(project)}</option>
              ))}
            </select>
            <small>This updates the Codex project assignment, not the conversation's working directory.</small>
            <div className="project-move-actions">
              <button type="button" disabled={projectMutationBusy} onClick={()=>setProjectMoveThread(null)}>Cancel</button>
              <button type="submit" disabled={projectMutationBusy||projectMoveTarget===(projectMoveThread.projectId||"")}>
                {projectMutationBusy?"Saving…":"Move"}
              </button>
            </div>
          </form>
        </div>,document.body
      ):null}

      <FileReferenceContext.Provider value={{
        client,cwd:cwd||selectedThread?.cwd||"",
        openThread:(threadId:string)=>{void navigateToThread(threadId,[],"push");},
      }}>
      <main className="main-panel">
        <header className="topbar">
          {sidebarCollapsed ? (
            <button
              className="icon-button topbar-menu"
              aria-label="Open history"
              onClick={() => setSidebarCollapsed(false)}
            >
              <PanelLeftOpen size={18} />
            </button>
          ) : null}
          <button
            className="icon-button mobile-menu"
            aria-label="Open history"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu size={19} />
          </button>
          <div className="topbar-title">
            {threadTrail.length ? (
              <button
                type="button"
                className="thread-parent-link"
                disabled={loadingThread}
                onClick={returnToParentThread}
              >
                <ChevronRight size={13} />
                {parentThread ? (
                  <AgentIdentityMark
                    threadId={parentThread.id}
                    fallback={parentThread.title}
                  />
                ) : null}
                <span>Back to {parentThread?.title}</span>
              </button>
            ) : null}
            <span className="desktop-title">{selectedTitle}</span>
            <ChevronDown size={14} />
          </div>
          <div className="topbar-right">
            {selectedThread ? <button type="button" className="project-topbar-move"
              title="Copy Codex thread reference"
              aria-label="Copy Codex thread reference"
              onClick={()=>void copyConversationLink(selectedThread.id)}>
              <Link2 size={15}/> <span>Link</span>
            </button>:null}
            {selectedThread ? <button type="button" className="project-topbar-move"
              title="Move this conversation to a Codex project"
              aria-label="Move conversation to project"
              onClick={()=>{setProjectMoveThread(selectedThread);setProjectMoveTarget(selectedThread.projectId||"");}}>
              <FolderInput size={15}/> <span>Project</span>
            </button>:null}
            <a
              className="browser-shortcut"
              href="/browser"
              aria-label="Open the remote Codex browser"
              target="_blank"
              rel="noopener noreferrer"
            >
              <Globe size={15} aria-hidden="true" />
              <span>Browser</span>
            </a>
            <label className="theme-control" title="Color theme">
              <Sun size={14} aria-hidden="true" />
              <select
                aria-label="Color theme"
                value={themeChoice}
                onChange={(event) => {
                  const nextTheme = event.currentTarget.value as ThemeChoice;
                  setThemeChoice(nextTheme);
                  try {
                    localStorage.setItem(themeChoiceKey, nextTheme);
                  } catch {}
                }}
              >
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
          </div>
        </header>

        {selectedThread && client ? <ThreadGoalPanel key={selectedThread.id}
          client={client} threadId={selectedThread.id} revision={goalRevision}
          onError={error=>setNotice({tone:"error",text:"Goal: "+error})}/> : null}

        {status.daemon.available ? null : (
          <div className="daemon-banner" role="status">
            <div className="daemon-banner-icon">
              <Terminal size={17} />
            </div>
            <div>
              <strong>Codex daemon unavailable</strong>
              <span>
                {status.daemon.error ||
                  "Start the official Codex app server, then reconnect."}
              </span>
            </div>
            <button
              className="text-button"
              onClick={() => void refreshStatus()}
            >
              Retry
            </button>
          </div>
        )}

        {newVersionAvailable ? (
          <div className="update-banner" role="status">
            <div className="update-banner-copy">
              <strong>New version available.</strong>
              {composer.trim() || uploads.length || compressingUploads ? (
                <span>
                  Refreshing will discard your unsent message and attachments.
                </span>
              ) : (
                <span>Refresh to use the latest version.</span>
              )}
            </div>
            <button
              type="button"
              aria-label="Refresh to use the new version"
              onClick={() => window.location.reload()}
            >
              Refresh
            </button>
          </div>
        ) : null}

        {connectionMessage &&
        connection !== "online" &&
        status.daemon.available ? (
          <div className="connection-banner" role="status">
            <span className="status-dot" />
            {connectionMessage}
          </div>
        ) : null}

        {notice ? (
          <div
            className={`notice ${notice.tone}`}
            role={notice.tone === "error" ? "alert" : "status"}
          >
            <span>{notice.text}</span>
            <button
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
            >
              <X size={15} />
            </button>
          </div>
        ) : null}

        <div
          className="conversation-view"
          ref={timelineRef}
          onScroll={(event) => {
            const element = event.currentTarget;
            scrollWasNearBottom.current =
              element.scrollHeight - element.scrollTop - element.clientHeight <
              160;
          }}
        >
          {selectedThread && itemCursor ? (
            <button
              className="load-history-button"
              disabled={loadingOlderItems}
              onClick={() => void loadOlderItems()}
            >
              {loadingOlderItems ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <ArrowUp size={15} />
              )}
              <span>Load earlier messages</span>
            </button>
          ) : null}
          {loadingThread ? (
            <div className="history-loading">
              <LoaderCircle className="spin" size={18} />
              Restoring conversation…
            </div>
          ) : null}
          {!selectedThread && items.length === 0 && visibleOptimistic.length === 0 ? (
            <div className="welcome-state">
              <div className="welcome-mark">
                <Code2 size={23} />
              </div>
              <p className="eyebrow">YOUR CODEX WORKSPACE</p>
              <h1>
                What are we
                <br />
                <em>working on?</em>
              </h1>
              <p className="welcome-description">
                Ask Codex to explore, build, or explain something in your
                workspace.
              </p>
              <label className="new-conversation-project">
                <span>Project</span>
                <select aria-label="New conversation project" value={newProjectId}
                  onChange={event=>selectNewProject(event.target.value)}>
                  <option value="">No project</option>
                  {codexProjects.map(project=><option key={project.id} value={project.id}>
                    {projectOptionLabel(project)}
                  </option>)}
                </select>
              </label>
              <div className="suggestion-list">
                <button
                  onClick={() =>
                    setComposer("Explain the structure of this project")
                  }
                >
                  <span className="suggestion-icon">
                    <FileText size={16} />
                  </span>
                  <span>
                    <strong>Explore this project</strong>
                    <small>Get a quick overview of the codebase</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
                <button
                  onClick={() =>
                    setComposer(
                      "Help me fix the most important issue in this codebase",
                    )
                  }
                >
                  <span className="suggestion-icon">
                    <Command size={16} />
                  </span>
                  <span>
                    <strong>Make a change</strong>
                    <small>Describe a task and work through it</small>
                  </span>
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>
          ) : null}
          {timelineGrouping.groups.map((group) => {
            if (group.kind === "message")
              return (
                <TimelineCard
                  key={group.key}
                  entry={group.entry}
                  onOpenThread={openAgentThread}
                  onFork={forkConversationAtMessage}
                  forkBusy={forkBusy}
                />
              );
            const openKey = `${selectedRef.current ?? "new"}:${group.key}`;
            const isOpen =
              activityGroupOverrides[openKey] ??
              group.defaultOwnerKey === timelineGrouping.latestMessageOwnerKey;
            return (
              <ResponseActivityGroup
                key={group.key}
                entries={group.entries}
                isOpen={isOpen}
                onToggle={() =>
                  setActivityGroupOverrides((current) => ({
                    ...current,
                    [openKey]: !isOpen,
                  }))
                }
                onOpenThread={openAgentThread}
              />
            );
          })}
          {visibleOptimistic.map(message=><OptimisticMessageBubble
            key={message.id} message={message}
            onRestore={()=>void restoreOptimistic(message)}/>)}
          {turnActive && !items.some((entry) => entry.streaming) ? (
            <div className="thinking-indicator">
              <span />
              <span />
              <span />
              Codex is working
            </div>
          ) : null}
        </div>

        <div className="composer-wrap">
          {queueSteerRecovery &&
          queueSteerRecovery.threadId !== selectedThread?.id ? (
            <div className="queued-message-state error" role="status">
              <span>
                A saved queue recovery is waiting in another conversation.
                Resolve it there before steering another message.
              </span>
              <button
                type="button"
                onClick={() => {
                  void navigateToThread(
                    queueSteerRecovery.threadId,
                    [],
                    "push",
                  );
                }}
              >
                Open conversation
              </button>
            </div>
          ) : null}
          {selectedThread &&
          (queueThreadId === selectedThread.id || selectedQueueRecovery) ? (
            <QueuedMessageStack
              submissions={
                queueThreadId === selectedThread.id ? queuedSubmissions : []
              }
              expanded={queueExpanded}
              onToggle={() => setQueueExpanded((current) => !current)}
              onRetry={() => {
                if (!client || selectedRef.current !== selectedThread.id)
                  return;
                setQueueLoading(true);
                setQueueError("");
                void refreshThreadQueue(client, selectedThread.id);
              }}
              loading={queueLoading}
              error={queueError}
              canSteer={canSteerQueuedMessage}
              steeringSubmissionId={steeringSubmissionId}
              steerUnavailableReason={queueSteerUnavailableReason}
              onSteer={(submission) => void steerQueuedSubmission(submission)}
              recovery={selectedQueueRecovery}
              onCheckRecovery={() => void reconcileQueueSteerRecovery()}
              onRestoreRecovery={(allowUnknown) =>
                void restoreQueueSteerRecovery(allowUnknown)
              }
              recoveryBusy={steeringSubmissionId !== null}
            />
          ) : null}
          <form className="composer-card" onSubmit={sendMessage}>
            {selectedThread?.canAcceptDirectInput === false ? (
              <div className="agent-read-only" role="status">
                This agent is controlled by its parent.
              </div>
            ) : null}
            {uploads.length ? (
              <div className="upload-strip">
                {uploads.map((upload) => (
                  <div className="upload-chip" key={upload.id}>
                    <img src={upload.dataUrl} alt="" />
                    <span>{upload.name}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${upload.name}`}
                      disabled={
                        compressingUploads ||
                        compactingThreadId !== null ||
                        selectedThread?.canAcceptDirectInput === false
                      }
                      onClick={() =>
                        updateUploads((current) =>
                          current.filter((item) => item.id !== upload.id),
                        )
                      }
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <label className="sr-only" htmlFor="composer">
              Message Codex
            </label>
            <textarea
              ref={composerRef}
              id="composer"
              onPaste={handleComposerPaste}
              value={composer}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={Boolean(completionTarget && composerCanComplete)}
              aria-controls={
                completionTarget && composerCanComplete
                  ? "composer-completions"
                  : undefined
              }
              aria-activedescendant={
                completionTarget &&
                composerCanComplete &&
                completionItems[completionIndex]
                  ? `composer-completion-${completionIndex}`
                  : undefined
              }
              onClick={(event) =>
                syncCompletionTarget(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                )
              }
              onKeyUp={(event) =>
                syncCompletionTarget(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                )
              }
              onSelect={(event) =>
                syncCompletionTarget(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                )
              }
              onChange={(event) => {
                handleComposerChange(
                  event.currentTarget.value,
                  event.currentTarget.selectionStart,
                );
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
              }}
              onKeyDown={(event) => {
                if (
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return;
                if (completionTarget && event.key === "Escape") {
                  event.preventDefault();
                  dismissedCompletionRef.current = {
                    kind: completionTarget.kind,
                    token: composer.slice(
                      completionTarget.start,
                      completionTarget.end,
                    ),
                  };
                  setCompletionTarget(null);
                  setCompletionItems([]);
                  return;
                }
                if (
                  completionItems.length > 0 &&
                  completionTarget &&
                  composerCanComplete
                ) {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setCompletionIndex(
                      (current) => (current + 1) % completionItems.length,
                    );
                    return;
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setCompletionIndex(
                      (current) =>
                        (current - 1 + completionItems.length) %
                        completionItems.length,
                    );
                    return;
                  }
                  const unmodifiedKey =
                    !event.shiftKey &&
                    !event.ctrlKey &&
                    !event.metaKey &&
                    !event.altKey;
                  if (
                    unmodifiedKey &&
                    (event.key === "Enter" || event.key === "Tab")
                  ) {
                    event.preventDefault();
                    selectCompletion(completionItems[completionIndex]);
                    return;
                  }
                }
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229
                ) {
                  event.preventDefault();
                  void sendMessage(undefined, hasActiveTurn ? "steer" : "auto");
                }
              }}
              placeholder={
                connection === "online"
                  ? "Message Codex…"
                  : "Waiting for the Codex connection…"
              }
              rows={1}
              disabled={
                connection !== "online" ||
                selectedThread?.canAcceptDirectInput === false
              }
              readOnly={
                sending ||
                queueing ||
                compactingThreadId !== null ||
                steeringSubmissionId !== null
              }
              aria-busy={
                sending ||
                queueing ||
                compactingThreadId !== null ||
                steeringSubmissionId !== null
              }
            />
            {completionTarget && composerCanComplete ? (
              <div className="composer-completions" id="composer-completions">
                <div className="composer-completions-heading">
                  {completionTarget.kind === "mention"
                    ? "Plugins and files"
                    : completionTarget.kind === "skill"
                      ? "Skills"
                      : "Commands"}
                </div>
                <div
                  role="listbox"
                  aria-label={
                    completionTarget.kind === "command"
                      ? "Slash commands"
                      : "Composer suggestions"
                  }
                >
                  {completionLoading ? (
                    <div className="composer-completion-status" role="status">
                      Searching…
                    </div>
                  ) : completionError ? (
                    <div className="composer-completion-status" role="status">
                      {completionError}
                    </div>
                  ) : completionItems.length ? (
                    completionItems.map((item, index) => (
                      <button
                        type="button"
                        role="option"
                        id={`composer-completion-${index}`}
                        aria-selected={index === completionIndex}
                        disabled={
                          item.kind === "command" && Boolean(item.disabled)
                        }
                        aria-disabled={
                          item.kind === "command" && item.disabled
                            ? "true"
                            : undefined
                        }
                        className={`composer-completion-option ${item.kind === "command" ? "command" : ""} ${item.kind === "command" && item.disabled ? "disabled" : ""} ${index === completionIndex ? "selected" : ""}`}
                        key={
                          item.kind === "command"
                            ? `${item.command}:${index}`
                            : item.kind === "plugin"
                              ? `plugin:${item.id}`
                              : `${item.path}:${index}`
                        }
                        title={
                          item.kind === "command" ? item.description : item.kind === "plugin" ? item.description : item.path
                        }
                        onPointerDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setCompletionIndex(index)}
                        onClick={() => selectCompletion(item)}
                      >
                        {item.kind === "plugin" ? (
                          <>
                            <Code2 size={15} aria-hidden="true"/>
                            <span className="composer-completion-copy">
                              <strong>@{item.name}</strong>
                              <small>{item.description}</small>
                            </span>
                          </>
                        ) : item.kind === "file" ? (
                          <>
                            <FileText size={15} aria-hidden="true" />
                            <span className="composer-completion-copy">
                              <strong>{item.label}</strong>
                              <small>
                                {item.isDirectory ? "Folder" : "File"}
                              </small>
                            </span>
                          </>
                        ) : item.kind === "skill" ? (
                          <>
                            <Code2 size={15} aria-hidden="true" />
                            <span className="composer-completion-copy">
                              <strong>${item.name}</strong>
                              <small>{item.description || item.path}</small>
                            </span>
                          </>
                        ) : (
                          <>
                            <Command size={15} aria-hidden="true" />
                            <span className="composer-completion-copy">
                              <strong>{item.command}</strong>
                              <small>
                                {item.disabled
                                  ? item.disabledReason
                                  : item.description}
                              </small>
                            </span>
                          </>
                        )}
                      </button>
                    ))
                  ) : (
                    <div className="composer-completion-status" role="status">
                      {completionTarget.kind === "command"
                        ? "No supported commands found."
                        : completionTarget.kind === "mention"
                          ? "No matching installed plugins or files."
                          : "No skills found."}
                    </div>
                  )}
                </div>
                <div className="composer-completions-hint">
                  ↑↓ to navigate · Enter to select · Esc to dismiss
                </div>
              </div>
            ) : null}
            <div className="composer-toolbar">
              <div className="composer-tools">
                <label
                  className="composer-tool attach-tool"
                  title="Attach an image"
                >
                  <ImagePlus size={17} />
                  <span className="sr-only">Attach image</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    disabled={
                      compressingUploads ||
                      sending ||
                      queueing ||
                      compactingThreadId !== null ||
                      selectedThread?.canAcceptDirectInput === false
                    }
                    onChange={(event) => {
                      void addImages(event.currentTarget.files);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <button
                  type="button"
                  className={`composer-tool ${showOptions ? "active" : ""}`}
                  title="Model and permission options"
                  aria-expanded={showOptions}
                  disabled={
                    sending ||
                    queueing ||
                    selectedThread?.canAcceptDirectInput === false
                  }
                  onClick={() => { setShowSettings(false); setShowOptions((value) => !value); }}
                >
                  <Shield size={16} />
                  <span className="settings-label">Options</span>
                  <ChevronDown size={13} />
                </button>
                {selectedThread ? (
                  <ContextUsageIndicator usage={threadTokenUsage} />
                ) : null}
              </div>
              <div className="composer-right">
                <span className="composer-hint">
                  {hasActiveTurn
                    ? "Enter to steer · Shift + Enter for a new line"
                    : "Enter to send · Shift + Enter for a new line"}
                </span>
                {hasActiveTurn ? (
                  <>
                    {hasComposerContent ? (
                      <div className="composer-active-actions">
                        <button
                          type="button"
                          className="composer-action queue-action"
                          onClick={() => void queueMessage()}
                          onPointerDown={preserveComposerFocusOnPointerDown}
                          disabled={!canSteerOrQueue}
                          aria-disabled={
                            sending || queueing || steeringSubmissionId !== null
                          }
                          title="Add this reply to the daemon's thread queue"
                        >
                          {queueing ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : null}
                          Queue
                        </button>
                        <button
                          type="button"
                          className="composer-action steer-action"
                          onClick={() => void sendMessage(undefined, "steer")}
                          onPointerDown={preserveComposerFocusOnPointerDown}
                          disabled={!canSteerOrQueue}
                          aria-disabled={
                            sending || queueing || steeringSubmissionId !== null
                          }
                        >
                          {sending ? (
                            <LoaderCircle className="spin" size={13} />
                          ) : null}
                          Steer
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="send-button stop-button"
                      onClick={() => void interruptTurn()}
                      disabled={
                        interrupting ||
                        !activeTurnId ||
                        connection !== "online" ||
                        loadingThread ||
                        sending ||
                        queueing ||
                        selectedRef.current !== (selectedThread?.id ?? null) ||
                        selectedThread?.canAcceptDirectInput === false
                      }
                      aria-label="Interrupt turn"
                      title="Stop turn"
                    >
                      {interrupting ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : (
                        <Square size={13} fill="currentColor" />
                      )}
                    </button>
                  </>
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    disabled={!canSubmit}
                    aria-label="Send message"
                  >
                    {sending || compactingThreadId ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <ArrowUp size={18} strokeWidth={2.3} />
                    )}
                  </button>
                )}
              </div>
            </div>
            {(showSettings || showOptions)
              ? createPortal(
                  <div
                    className="modal-scrim settings-scrim"
                    onClick={() => { setShowSettings(false); setShowOptions(false); }}
                  >
                    <section
                      className="settings-panel"
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="settings-title"
                      onClick={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") { setShowSettings(false); setShowOptions(false); }
                      }}
                    >
                      <div className="settings-panel-heading">
                        <div>
                          <strong id="settings-title">{showOptions ? "Conversation Options" : "Global Settings"}</strong>
                          <span>{showOptions
                            ? "Model, reasoning, permissions, and plugin preferences for this conversation."
                            : "Codex account, usage, installed apps, device preferences, and history."}</span>
                        </div>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label="Close settings"
                          autoFocus
                          onClick={() => { setShowSettings(false); setShowOptions(false); }}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      {showOptions ? (<>
                      <h3 className="settings-section-title">Run settings</h3>
                      <div className="settings-grid">
                        <label>
                          <span>Model</span>
                          <select
                            value={model}
                            onChange={(event) =>
                              selectModel(event.target.value)
                            }
                          >
                            <option value="">Daemon default</option>
                            {models.map((entry) => (
                              <option key={entry.id} value={entry.model}>
                                {entry.displayName || entry.model}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Reasoning</span>
                          <select
                            value={effort}
                            onChange={(event) => setEffort(event.target.value)}
                          >
                            <option value="">Daemon default</option>
                            {availableEfforts.map((option) => (
                              <option
                                key={option.reasoningEffort}
                                value={option.reasoningEffort}
                              >
                                {capitalize(option.reasoningEffort)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Approval policy</span>
                          <select
                            value={approvalPolicy}
                            onChange={(event) =>
                              setApprovalPolicy(event.target.value)
                            }
                          >
                            <option value="">Keep current policy</option>
                            <option value="on-request">On request</option>
                            <option value="untrusted">Untrusted</option>
                            <option value="never">Never</option>
                          </select>
                        </label>
                        <label>
                          <span>Sandbox</span>
                          <select
                            value={sandboxMode}
                            onChange={(event) =>
                              setSandboxMode(event.target.value)
                            }
                          >
                            <option value="">Keep current sandbox</option>
                            <option value="read-only">
                              Read only · network off
                            </option>
                            <option value="workspace-write">
                              Workspace write
                            </option>
                            <option value="danger-full-access">
                              Full access
                            </option>
                          </select>
                        </label>
                        {!selectedThread ? (
                          <label className="cwd-setting">
                            <span>Project</span>
                            <select aria-label="New conversation project in options" value={newProjectId}
                              onChange={event=>selectNewProject(event.target.value)}>
                              <option value="">No project</option>
                              {codexProjects.map(project=><option key={project.id} value={project.id}>
                                {projectOptionLabel(project)}
                              </option>)}
                            </select>
                            <small>Saved as the official Codex project ID when this conversation starts.</small>
                            <span>Working directory</span>
                            <span>Working directory</span>
                            <input
                              value={cwd}
                              onChange={(event) => setCwd(event.target.value)}
                              placeholder="/path/to/project"
                              autoCapitalize="off"
                              autoCorrect="off"
                              spellCheck={false}
                            />
                            <small>Used when this conversation starts.</small>
                            <small>
                              Daemon permissions apply unless you choose an
                              override.
                            </small>
                          </label>
                        ) : (
                          <div className="current-policy">
                            <span>Current daemon policy</span>
                            <strong>
                              {describeApproval(threadDetails?.approvalPolicy)}{" "}
                              · {describeSandbox(threadDetails?.sandbox)}
                            </strong>
                            {threadDetails?.activePermissionProfile?.id ? (
                              <small>
                                Profile:{" "}
                                {threadDetails.activePermissionProfile.id}
                              </small>
                            ) : (
                              <small>
                                New choices apply to your next turn.
                              </small>
                            )}
                          </div>
                        )}
                      </div>
                      <ThreadPluginOptions rpc={client} visible={showOptions && connection === "online"}
                        threadId={selectedThread?.id || null} disabledIds={disabledPluginIds}
                        onChange={setDisabledPluginIds} />
                      </>) : (<>
                      <div className="settings-preferences">
                        <div className="settings-preference">
                          <div>
                            <strong>Interface language</strong>
                            <span>Switch the interface between Chinese and English. Conversation content is unchanged.</span>
                          </div>
                          <label className="interface-language-field">
                            <span className="sr-only">Language</span>
                            <select aria-label="Interface language" value={interfaceLanguage}
                              onChange={event=>setInterfaceLanguageChoice(event.target.value==="zh"?"zh":"en")}>
                              <option value="zh">简体中文</option>
                              <option value="en">English</option>
                            </select>
                          </label>
                        </div>
                      </div>
                      <CodexAccountPlugins rpc={client} visible={showSettings && connection === "online"} />
                      <div className="settings-preferences">
                        <div className="thread-indicator-preference-heading">
                          <div>
                            <h3 className="settings-section-title">Conversation status markers</h3>
                            <span>Configure the visibility, color and shape of each status on this device.</span>
                          </div>
                          <button type="button" className="settings-toggle"
                            onClick={() => setThreadStatusPreferences(structuredClone(defaultThreadStatusPreferences))}>
                            Reset
                          </button>
                        </div>
                        {threadStatusOrder.map((kind) => (
                          <div key={kind} className="thread-indicator-preference-row">
                            <span className="thread-status-indicator"
                              style={{backgroundColor: threadStatusPreferences[kind].color,
                                borderRadius: threadStatusPreferences[kind].shape === "circle" ? "50%" : "2px"}}
                              aria-hidden="true" />
                            <strong>{threadStatusLabels[kind]}</strong>
                            <label className="thread-indicator-color">
                              <span className="sr-only">{threadStatusLabels[kind]} color</span>
                              <input type="color" value={threadStatusPreferences[kind].color}
                                aria-label={`${threadStatusLabels[kind]} color`}
                                onChange={(event) => {
                                  const color = event.target.value;
                                  setThreadStatusPreferences((current) => ({...current, [kind]: {...current[kind],color}}));
                                }} />
                            </label>
                            <label>
                              <span className="sr-only">{threadStatusLabels[kind]} shape</span>
                              <select aria-label={`${threadStatusLabels[kind]} shape`}
                                value={threadStatusPreferences[kind].shape}
                                onChange={(event) => {
                                  const shape = event.target.value === "square" ? "square" : "circle";
                                  setThreadStatusPreferences((current) => ({...current, [kind]: {...current[kind],shape}}));
                                }}>
                                <option value="circle">Circle</option>
                                <option value="square">Square</option>
                              </select>
                            </label>
                            <button type="button" className="settings-toggle"
                              aria-label={`${threadStatusLabels[kind]} marker visibility`}
                              aria-pressed={threadStatusPreferences[kind].enabled}
                              onClick={() => setThreadStatusPreferences((current) => ({...current,
                                [kind]: {...current[kind], enabled: !current[kind].enabled}}))}>
                              {threadStatusPreferences[kind].enabled ? "On" : "Off"}
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="settings-preferences">
                        <h3 className="settings-section-title">
                          Device preferences
                        </h3>
                        <div className="settings-preference">
                          <div>
                            <strong>Completion sound</strong>
                            <span>
                              Play a short tone when a turn finishes in this
                              tab.
                            </span>
                          </div>
                          <button
                            type="button"
                            className="settings-toggle"
                            aria-pressed={completionSoundEnabled}
                            disabled={
                              typeof window.AudioContext === "undefined"
                            }
                            onClick={() =>
                              updateCompletionSound(!completionSoundEnabled)
                            }
                          >
                            {completionSoundEnabled ? "On" : "Off"}
                          </button>
                        </div>
                        <div className="settings-preference">
                          <div>
                            <strong>Question notifications</strong>
                            <span>
                              {pushSetupState === "unsupported"
                                ? "This browser does not support push notifications."
                                : pushSetupState === "loading"
                                  ? "Checking notification support…"
                                  : pushSetupState === "error"
                                    ? `Notification setup needs attention: ${pushError}`
                                    : pushSetupState === "unavailable"
                                      ? "Push notifications are not configured on this server."
                                      : pushSetupState === "denied"
                                        ? "Notifications are blocked in browser settings. Change site permission to enable them."
                                        : questionNotificationsEnabled
                                          ? "This device is subscribed. Keep a chat connected to receive questions."
                                          : "Get notified when Codex asks a question. New questions won’t be detected after all chats disconnect."}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="settings-toggle"
                            aria-pressed={questionNotificationsEnabled}
                            disabled={
                              pushBusy ||
                              pushSetupState === "loading" ||
                              (!pushConfiguration &&
                                pushSetupState !== "error") ||
                              (pushConfiguration &&
                                (!pushConfiguration.ready ||
                                  !pushConfiguration.publicKey) &&
                                !questionNotificationsEnabled) ||
                              pushSetupState === "unsupported" ||
                              (pushSetupState === "denied" &&
                                !questionNotificationsEnabled)
                            }
                            onClick={() =>
                              questionNotificationsEnabled
                                ? void disableQuestionNotifications()
                                : !pushConfiguration
                                  ? void retryQuestionNotificationSetup()
                                  : void enableQuestionNotifications()
                            }
                          >
                            {pushBusy
                              ? "Saving…"
                              : !pushConfiguration && pushSetupState === "error"
                                ? "Retry"
                                : questionNotificationsEnabled
                                  ? "Turn off"
                                  : "Turn on"}
                          </button>
                        </div>
                      </div>
                      <div className="settings-history">
                        <div>
                          <strong>Archived conversations</strong>
                          <span>
                            View and restore conversations you’ve archived.
                          </span>
                        </div>
                        <button
                          type="button"
                          className="settings-history-button"
                          onClick={() => {
                            setShowSettings(false);
                            setArchivedThreads(true);
                            setThreadCursor(null);
                            setThreadSearch("");
                            setSidebarSearchOpen(false);
                            setSidebarSection("chats");
                            if (client)
                              void refreshThreads(client, true, false);
                            if (window.matchMedia("(max-width: 760px)").matches)
                              setMobileSidebarOpen(true);
                          }}
                        >
                          Browse archived chats
                          <ChevronRight size={15} />
                        </button>
                      </div>
                      <div className="settings-history settings-account">
                        <div>
                          <strong>Session</strong>
                          <span>Sign out of this browser session.</span>
                        </div>
                        <button
                          type="button"
                          className="settings-history-button settings-signout-button"
                          onClick={() => {
                            setShowSettings(false);
                            void signOut();
                          }}
                        >
                          Sign out
                        </button>
                      </div>
                      </>)}
                    </section>
                  </div>,
                  document.body,
                )
              : null}
          </form>
        </div>
      </main>
      </FileReferenceContext.Provider>

      {approvalPrompt ? (
        <ApprovalDialog
          prompt={approvalPrompt}
          unknown={unknownRequest}
          answers={questionAnswers}
          setAnswers={setQuestionAnswers}
          onReply={(result) => replyApproval(approvalPrompt, result)}
          onRejectUnknown={() => rejectUnknownRequest(approvalPrompt)}
        />
      ) : null}
    </div>
  );
}

type BrowserTabInfo = {
  id: number;
  title: string;
  url: string;
  active: boolean;
};

type BrowserFrame = {
  data: string;
  width: number;
  height: number;
  title: string;
  url: string;
};

async function browserRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/browser${path}`, {
    cache: "no-store",
    credentials: "same-origin",
    ...init,
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const error =
      isRecord(body) && typeof body.error === "string"
        ? body.error
        : "The Codex browser could not complete that action.";
    throw new Error(error);
  }
  return body as T;
}

function BrowserSurface() {
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [selectedTabId, setSelectedTabId] = useState<number | null>(null);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [address, setAddress] = useState("");
  const [typedText, setTypedText] = useState("");
  const [controlsEnabled, setControlsEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const gesture = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const addressInput = useRef<HTMLInputElement>(null);

  const refreshTabs = useCallback(async () => {
    try {
      const next = await browserRequest<BrowserTabInfo[]>("/tabs");
      setTabs(next);
      setSelectedTabId((current) =>
        current !== null && next.some((tab) => tab.id === current)
          ? current
          : (next.find((tab) => tab.active)?.id ?? next[0]?.id ?? null),
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refreshTabs();
    const timer = window.setInterval(() => void refreshTabs(), 5000);
    return () => window.clearInterval(timer);
  }, [refreshTabs]);

  useEffect(() => {
    if (selectedTabId === null) {
      setFrame(null);
      setAddress("");
      return;
    }
    let cancelled = false;
    let pending = false;
    const capture = async () => {
      if (pending || document.visibilityState !== "visible") return;
      pending = true;
      try {
        const next = await browserRequest<BrowserFrame>(
          `/tabs/${selectedTabId}/screenshot`,
        );
        if (!cancelled) {
          setFrame(next);
          if (!addressInput.current?.matches(":focus")) setAddress(next.url);
          setError("");
        }
      } catch (cause) {
        if (!cancelled)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
      }
    };
    setFrame(null);
    void capture();
    const timer = window.setInterval(() => void capture(), 1400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [selectedTabId]);

  const post = useCallback(
    async (path: string, body: Record<string, unknown>) =>
      await browserRequest(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    [],
  );

  const toggleControls = () => {
    const next = !controlsEnabled;
    setControlsEnabled(next);
    setNotice(
      next
        ? "Manual controls are enabled. Codex automation can continue in this browser."
        : "Manual controls are disabled.",
    );
    setError("");
  };

  const runTabAction = async (
    action: string,
    params: Record<string, unknown> = {},
  ) => {
    if (!controlsEnabled || selectedTabId === null) return;
    setBusy(true);
    try {
      await post(`/tabs/${selectedTabId}`, { action, ...params });
      setError("");
      setNotice("");
      if (action === "navigate" || action === "reload" || action === "back")
        await refreshTabs();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const openAddress = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controlsEnabled) return;
    const value = address.trim();
    const url = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
    if (!/^https?:\/\//i.test(url)) {
      setError("Use an HTTP or HTTPS address.");
      return;
    }
    if (selectedTabId === null) {
      setBusy(true);
      try {
        const result = await browserRequest<{ id: number }>("/tabs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "new" }),
        });
        setSelectedTabId(result.id);
        setTabs(await browserRequest<BrowserTabInfo[]>("/tabs"));
        await post(`/tabs/${result.id}`, { action: "navigate", url });
        setError("");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(false);
      }
      return;
    }
    await runTabAction("navigate", { url });
  };

  const createTab = async () => {
    if (!controlsEnabled) return;
    setBusy(true);
    try {
      const result = await browserRequest<{ id: number }>("/tabs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "new" }),
      });
      const next = await browserRequest<BrowserTabInfo[]>("/tabs");
      setTabs(next);
      setSelectedTabId(result.id);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const sendText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!controlsEnabled || !typedText) return;
    await runTabAction("type", { text: typedText });
    setTypedText("");
  };

  const remotePoint = (event: ReactPointerEvent<HTMLImageElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(
          frame?.width ?? event.currentTarget.naturalWidth,
          ((event.clientX - bounds.left) / bounds.width) *
            event.currentTarget.naturalWidth,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          frame?.height ?? event.currentTarget.naturalHeight,
          ((event.clientY - bounds.top) / bounds.height) *
            event.currentTarget.naturalHeight,
        ),
      ),
    };
  };

  const beginGesture = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (!controlsEnabled || busy || event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
  };

  const endGesture = (event: ReactPointerEvent<HTMLImageElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    if (!controlsEnabled) return;
    const distance = Math.hypot(
      event.clientX - current.x,
      event.clientY - current.y,
    );
    const point = remotePoint(event);
    if (distance < 12) {
      void runTabAction("click", point);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const deltaX =
      -((event.clientX - current.x) / bounds.width) *
      (frame?.width ?? event.currentTarget.naturalWidth);
    const deltaY =
      -((event.clientY - current.y) / bounds.height) *
      (frame?.height ?? event.currentTarget.naturalHeight);
    void runTabAction("scroll", { ...point, deltaX, deltaY });
  };

  const title = frame?.title || "Codex browser";

  return (
    <main className="browser-page">
      <header className="browser-header">
        <a className="browser-back" href="/">
          <ChevronRight size={17} aria-hidden="true" />
          <span>Codex</span>
        </a>
        <div className="browser-title">
          <strong>{title}</strong>
          <span>
            {controlsEnabled ? "Manual controls enabled" : "Live browser view"}
          </span>
        </div>
        <button
          className={`browser-control-button ${controlsEnabled ? "enabled" : ""}`}
          type="button"
          onClick={toggleControls}
        >
          {controlsEnabled ? "Disable controls" : "Enable controls"}
        </button>
      </header>
      <div className="browser-tabbar">
        <label className="browser-tab-picker">
          <span>Browser tab</span>
          <select
            aria-label="Browser tab"
            value={selectedTabId ?? ""}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (!value) {
                setSelectedTabId(null);
                return;
              }
              const next = Number(value);
              setSelectedTabId(Number.isSafeInteger(next) ? next : null);
              if (controlsEnabled && Number.isSafeInteger(next))
                void post(`/tabs/${next}`, { action: "select" }).catch(
                  (cause) =>
                    setError(
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                );
            }}
          >
            {!tabs.length ? <option value="">No open tabs</option> : null}
            {tabs.map((tab) => {
              let host = "";
              try {
                host = new URL(tab.url).hostname;
              } catch {}
              return (
                <option key={tab.id} value={tab.id}>
                  {tab.title} {host ? `· ${host}` : ""}
                </option>
              );
            })}
          </select>
        </label>
        <button
          className="browser-toolbar-button"
          type="button"
          disabled={!controlsEnabled || busy || selectedTabId === null}
          onClick={() => void runTabAction("back")}
        >
          Back
        </button>
        <button
          className="browser-toolbar-button"
          type="button"
          disabled={!controlsEnabled || busy || selectedTabId === null}
          onClick={() => void runTabAction("reload")}
        >
          Reload
        </button>
        <button
          className="browser-toolbar-button"
          type="button"
          disabled={!controlsEnabled || busy}
          onClick={() => void createTab()}
        >
          New tab
        </button>
      </div>
      <form className="browser-addressbar" onSubmit={openAddress}>
        <input
          ref={addressInput}
          value={address}
          aria-label="Browser address"
          placeholder="Enter an HTTP or HTTPS address"
          onChange={(event) => setAddress(event.target.value)}
          readOnly={!controlsEnabled}
        />
        <button
          className="browser-toolbar-button open"
          type="submit"
          disabled={!controlsEnabled || busy}
        >
          Open
        </button>
      </form>
      <section className="browser-viewport" aria-label="Remote browser page">
        {frame ? (
          <img
            className={
              controlsEnabled
                ? "browser-screenshot interactive"
                : "browser-screenshot"
            }
            src={`data:image/jpeg;base64,${frame.data}`}
            alt={`Live Codex browser view of ${title}`}
            draggable={false}
            onContextMenu={(event) => event.preventDefault()}
            onPointerDown={beginGesture}
            onPointerUp={endGesture}
            onPointerCancel={() => {
              gesture.current = null;
            }}
          />
        ) : (
          <div className="browser-empty">
            <Globe size={24} aria-hidden="true" />
            <strong>
              {tabs.length
                ? "Loading browser page"
                : "No Codex browser tabs are open"}
            </strong>
            <span>
              {tabs.length
                ? "The live page will appear here."
                : "Enable controls to open a new tab, or have Codex open the service first."}
            </span>
          </div>
        )}
        {!controlsEnabled && frame ? (
          <div className="browser-watch-label">
            Watching · enable controls to interact
          </div>
        ) : null}
      </section>
      {controlsEnabled ? (
        <form className="browser-keyboard" onSubmit={sendText}>
          <input
            value={typedText}
            aria-label="Type into selected browser tab"
            placeholder="Type into the selected page"
            onChange={(event) => setTypedText(event.target.value)}
          />
          <button
            className="browser-toolbar-button"
            type="submit"
            disabled={busy || !typedText}
          >
            Type
          </button>
          <button
            className="browser-toolbar-button"
            type="button"
            disabled={busy || selectedTabId === null}
            onClick={() => void runTabAction("key", { key: "Enter" })}
          >
            Enter
          </button>
        </form>
      ) : null}
      {error || notice ? (
        <div
          className={`browser-feedback ${error ? "error" : ""}`}
          role="status"
        >
          {error || notice}
        </div>
      ) : null}
    </main>
  );
}

function LoginScreen({
  token,
  setToken,
  busy,
  error,
  onSubmit,
  language,
  setLanguage,
}: {
  token: string;
  setToken: (value: string) => void;
  busy: boolean;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  language: InterfaceLanguage;
  setLanguage: (value: InterfaceLanguage) => void;
}) {
  return (
    <div className="login-page">
      <div className="login-ornament ornament-one" />
      <div className="login-ornament ornament-two" />
      <div className="login-card">
        <label className="login-language">
          <span className="sr-only">Interface language</span>
          <select aria-label="Interface language" value={language}
            onChange={(event)=>setLanguage(event.target.value==="zh"?"zh":"en")}>
            <option value="zh">简体中文</option>
            <option value="en">English</option>
          </select>
        </label>
        <div className="login-brand">
          <span className="brand-mark">
            <Code2 size={18} />
          </span>
          <span>
            Codex <span>Desk</span>
          </span>
        </div>
        <div className="login-icon">
          <Command size={22} />
        </div>
        <p className="eyebrow">YOUR PRIVATE WORKSPACE</p>
        <h1>Connect to Codex</h1>
        <p className="login-description">
          Enter your access token to open a secure connection to your Codex
          daemon.
        </p>
        <form onSubmit={onSubmit}>
          <label htmlFor="access-token">Access token</label>
          <input
            id="access-token"
            type="password"
            autoComplete="current-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            required
            autoFocus
            placeholder="Paste your token"
          />
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <button className="login-submit" disabled={busy || !token.trim()}>
            {busy ? (
              <>
                <LoaderCircle className="spin" size={16} /> Connecting…
              </>
            ) : (
              <>
                Open workspace <ArrowUp size={16} />
              </>
            )}
          </button>
        </form>
        <div className="login-security">
          <Shield size={14} />
          <span>
            Your token stays on this server and is not stored in your browser.
          </span>
        </div>
      </div>
      <div className="login-footer">
        A focused interface for the official Codex daemon
      </div>
    </div>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return (
    <div className="loading-screen">
      <span className="brand-mark">
        <Code2 size={18} />
      </span>
      <LoaderCircle className="spin" size={19} />
      <span>{label}</span>
    </div>
  );
}

function UnavailableScreen({
  message,
  retry,
}: {
  message: string;
  retry: () => void;
}) {
  return (
    <div className="login-page">
      <div className="login-card unavailable-card">
        <div className="login-brand">
          <span className="brand-mark">
            <Code2 size={18} />
          </span>
          <span>
            Codex <span>Desk</span>
          </span>
        </div>
        <div className="login-icon">
          <Terminal size={21} />
        </div>
        <p className="eyebrow">WORKSPACE CONNECTION</p>
        <h1>Can’t reach the server</h1>
        <p className="login-description">{message}</p>
        <button className="login-submit" onClick={retry}>
          Try again <ArrowUp size={16} />
        </button>
      </div>
      <div className="login-footer">
        A focused interface for the official Codex daemon
      </div>
    </div>
  );
}

function ResponseActivityGroup({
  entries,
  isOpen,
  onToggle,
  onOpenThread,
}: {
  entries: TimelineItem[];
  isOpen: boolean;
  onToggle: () => void;
  onOpenThread: (threadId: string, parentThreadId?: string) => void;
}) {
  const activityLabels = entries
    .slice(0, 2)
    .map((entry) => activityLabel(entry.item));
  const remainingCount = entries.length - activityLabels.length;

  return (
    <section className="response-activity-run">
      <button
        type="button"
        className="response-activity-toggle"
        aria-expanded={isOpen}
        aria-label={`${isOpen ? "Hide" : "Show"} ${entries.length} activity ${entries.length === 1 ? "item" : "items"} for this response`}
        onClick={onToggle}
      >
        <span className="response-activity-count">
          {entries.length === 1 ? "1 activity" : `${entries.length} activities`}
        </span>
        <span className="response-activity-preview">
          {activityLabels.join(" · ")}
          {remainingCount > 0 ? ` · +${remainingCount} more` : ""}
        </span>
        <ChevronDown className="activity-chevron" size={15} />
      </button>
      <div className="response-activity-items" hidden={!isOpen}>
        {entries.map((entry) => (
          <TimelineCard
            key={`${entry.turnId}-${entry.item.id}`}
            entry={entry}
            onOpenThread={onOpenThread}
          />
        ))}
      </div>
    </section>
  );
}

function activityLabel(item: ThreadItem): string {
  if (item.type === "commandExecution") {
    const command = asString(item.command).trim().replace(/\s+/g, " ");
    if (!command) return "Ran command";
    const preview = command.length > 48 ? `${command.slice(0, 45)}…` : command;
    return `Ran ${preview}`;
  }
  if (item.type === "fileChange") return "File changes";
  if (item.type === "reasoning") return "Reasoning";
  if (item.type === "plan") return "Plan";
  if (item.type === "webSearch") return "Web search";
  if (item.type === "mcpToolCall")
    return (
      [asString(item.server), asString(item.tool)]
        .filter(Boolean)
        .join(" · ") || "MCP tool"
    );
  if (item.type === "dynamicToolCall")
    return asString(item.tool) || "Tool call";
  if (item.type === "collabAgentToolCall") return "Subagent";
  if (item.type === "subAgentActivity") {
    const path = asString(item.agentPath);
    const agent = path.split("/").filter(Boolean).at(-1) || "Agent";
    const kind = asString(item.kind);
    return `${agent} ${kind === "completed" ? "finished" : kind || "updated"}`;
  }
  if (item.type === "imageView") return "Viewed an image";
  return humanizeItemType(item.type);
}

function OptimisticMessageBubble({message,onRestore}:{
  message:OptimisticSubmission;onRestore:()=>void;
}){
  const uncertain=message.status==="unconfirmed";
  return <article className={`message-row user-row optimistic-message ${uncertain?"unconfirmed":""}`}
    aria-label={uncertain?"Message delivery could not be confirmed":"Message submitted"}>
    <div className="user-message-bubble">
      {message.input.map((part,index)=>(
        part.type==="text"?<div className="user-text" key={index}>{part.text}</div>:
        part.type==="image" && "url" in part ?
          <div className="optimistic-attachment" key={index}>
            {safeImageUrl(part.url)?<img src={part.url} alt="Attached image"/>:"Image attachment"}
          </div>:
          part.type==="skill" ? <span className="user-chip" key={index}>Skill · {part.name}</span>:
          part.type==="mention" ? <span className="user-chip" key={index}>@{part.name}</span>:null
      ))}
      <div className="optimistic-status" role="status">
        {uncertain?"Delivery unconfirmed":message.status==="sending"
          ? message.kind==="queue"?"Queuing…":"Sending…"
          : "Submitted · syncing…"}
        {uncertain?<button type="button" onClick={onRestore}>Check and restore draft</button>:null}
      </div>
      {uncertain&&message.error?<small className="optimistic-error">{message.error}</small>:null}
    </div>
  </article>;
}

function TimelineCard({
  entry,
  onOpenThread,
  onFork,
  forkBusy,
}: {
  entry: TimelineItem;
  onOpenThread: (threadId: string, parentThreadId?: string) => void;
  onFork?: (entry:TimelineItem)=>void;
  forkBusy?: boolean;
}) {
  const item = entry.item;
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>)
      : [];
    return (
      <article className="message-row user-row">
        <div className="user-message-with-actions">
          <div className="user-message-bubble">
            {content.map((part, index) => (
              <UserInputPart key={index} part={part} />
            ))}
          </div>
          {entry.turnId ? <button type="button" className="message-fork-button"
            disabled={forkBusy||Boolean(entry.streaming)}
            title="Fork before this user turn"
            onClick={()=>onFork?.(entry)}><GitBranch size={12}/> Fork here</button>:null}
        </div>
      </article>
    );
  }
  if (item.type === "agentMessage") {
    const text = asString(item.text);
    if (!text.trim() && item.delivery !== "failed") return null;
    return (
      <article className="message-row assistant-row">
        <div className="assistant-content" aria-live="polite">
          {entry.streaming ? (
            <div className="assistant-live-status">
              <span className="live-label">
                <i /> Writing
              </span>
            </div>
          ) : null}
          <MarkdownContent text={text} />
          {entry.turnId && !entry.streaming ? <button type="button" className="message-fork-button"
            disabled={forkBusy} title="Fork through this completed assistant turn"
            onClick={()=>onFork?.(entry)}><GitBranch size={12}/> Fork here</button>:null}
          {item.delivery === "failed" ? (
            <p className="delivery-error">
              This response could not be delivered.
            </p>
          ) : null}
        </div>
      </article>
    );
  }
  if (item.type === "commandExecution") {
    const command = asString(item.command);
    const compactCommand = command.trim().replace(/\s+/g, " ");
    const output = asString(item.aggregatedOutput);
    const outputLines = output.split(/\r\n|\r|\n/);
    if (/(?:\r\n|\r|\n)$/.test(output)) outputLines.pop();
    const previewLines = outputLines.slice(0, 3);
    const remainingLines = outputLines.slice(3);
    const status = activityStatus(
      item.status ?? (entry.streaming ? "inProgress" : undefined),
    );
    return (
      <details className="activity-card command-activity">
        <summary>
          <span className="activity-icon command">
            <Terminal size={13} />
          </span>
          <span className="activity-title" title={compactCommand}>
            {compactCommand
              ? `${entry.streaming ? "Running" : "Ran"} ${compactCommand}`
              : entry.streaming
                ? "Running command"
                : "Ran command"}
          </span>
          <span className={`activity-status ${status.className}`}>
            {status.label}
          </span>
          <ChevronDown className="activity-chevron" size={14} />
        </summary>
        <div className="activity-body command-activity-body">
          {command.trim() ? (
            <div>
              <pre>
                <code>{command}</code>
              </pre>
              {asString(item.cwd) ? (
                <div className="command-cwd">{asString(item.cwd)}</div>
              ) : null}
            </div>
          ) : null}
          {output.trim() ? (
            <div className="command-output">
              <div className="command-output-heading">
                <span>OUTPUT</span>
                {typeof item.exitCode === "number" ? (
                  <span>exit {item.exitCode}</span>
                ) : null}
              </div>
              <pre className="command-output-preview">
                <code>{previewLines.join("\n")}</code>
              </pre>
              {remainingLines.length ? (
                <details className="command-output-more">
                  <summary>
                    + {remainingLines.length} more{" "}
                    {remainingLines.length === 1 ? "line" : "lines"}
                  </summary>
                  <pre>
                    <code>{remainingLines.join("\n")}</code>
                  </pre>
                </details>
              ) : null}
            </div>
          ) : !command.trim() && !entry.streaming ? (
            <div className="command-details-unavailable">
              Command and output were not included in this activity item.
            </div>
          ) : null}
        </div>
      </details>
    );
  }
  if (item.type === "fileChange") {
    const changes = Array.isArray(item.changes)
      ? (item.changes as Array<Record<string, unknown>>)
      : [];
    const status = activityStatus(item.status);
    if (!changes.length) {
      if (entry.streaming)
        return (
          <div className="activity-card activity-progress">
            <span className="activity-icon file">
              <FilePlus2 size={14} />
            </span>
            <span className="activity-title">Preparing file changes</span>
            <span className="activity-status running">Running</span>
          </div>
        );
      if (["failed", "interrupted"].includes(status.className))
        return (
          <div className="activity-card activity-progress">
            <span className="activity-icon file">
              <FilePlus2 size={14} />
            </span>
            <span className="activity-title">File changes</span>
            <span className={`activity-status ${status.className}`}>
              {status.label}
            </span>
          </div>
        );
      return null;
    }
    return (
      <details className="activity-card">
        <summary>
          <span className="activity-icon file">
            <FilePlus2 size={14} />
          </span>
          <span className="activity-title">File changes</span>
          <span className="activity-count">
            {changes.length} {changes.length === 1 ? "file" : "files"}
          </span>
          <ChevronDown className="activity-chevron" size={15} />
        </summary>
        <div className="activity-body file-change-list">
          {changes.map((change, index) => (
            <details
              className="file-change"
              key={`${asString(change.path)}-${index}`}
            >
              <summary>
                <span className="change-kind">
                  {capitalize(asString(change.kind, "update"))}
                </span>
                <code>{asString(change.path)}</code>
                <ChevronDown className="activity-chevron" size={14} />
              </summary>
              <pre>
                <code>{asString(change.diff, "Diff unavailable")}</code>
              </pre>
            </details>
          ))}
        </div>
      </details>
    );
  }
  if (item.type === "reasoning") {
    const summary = (
      Array.isArray(item.summary)
        ? item.summary
        : typeof item.summary === "string"
          ? [item.summary]
          : []
    )
      .map((part) => asString(part).trim())
      .filter(Boolean)
      .join("\n");
    if (!summary) return null;
    return (
      <details className="reasoning-card">
        <summary>
          <span className="reasoning-spark">✳</span>
          <span>Reasoning summary</span>
          <ChevronDown className="activity-chevron" size={14} />
        </summary>
        <div className="reasoning-body">
          <MarkdownContent text={summary} />
        </div>
      </details>
    );
  }
  if (item.type === "plan") {
    const text = asString(item.text);
    if (!text.trim())
      return entry.streaming ? (
        <div className="activity-card activity-progress">
          <span className="activity-icon plan">
            <FileText size={14} />
          </span>
          <span className="activity-title">Preparing plan</span>
          <span className="activity-status running">Running</span>
        </div>
      ) : null;
    return (
      <details className="activity-card plan-card">
        <summary>
          <span className="activity-icon plan">
            <FileText size={14} />
          </span>
          <span className="activity-title">Plan</span>
          <ChevronDown className="activity-chevron" size={15} />
        </summary>
        <div className="activity-body">
          <MarkdownContent text={asString(item.text)} />
        </div>
      </details>
    );
  }
  if (item.type === "collabAgentToolCall")
    return <CollabAgentActivity item={item} onOpenThread={onOpenThread} />;
  if (item.type === "subAgentActivity")
    return <SubAgentActivity item={item} onOpenThread={onOpenThread} />;
  if (
    item.type === "mcpToolCall" ||
    item.type === "dynamicToolCall" ||
    item.type === "functionCallOutput"
  )
    return <ToolActivity item={item} streaming={entry.streaming} />;
  if (item.type === "webSearch") {
    if (!hasMeaningfulActivityDetails(item))
      return entry.streaming ? <ToolActivity item={item} streaming /> : null;
    return (
      <details className="activity-card">
        <summary>
          <span className="activity-icon search">
            <CircleHelp size={14} />
          </span>
          <span className="activity-title">Web search</span>
          <ChevronDown className="activity-chevron" size={15} />
        </summary>
        <div className="activity-body">
          <pre>
            <code>{formatActivityDetails(item)}</code>
          </pre>
        </div>
      </details>
    );
  }
  if (item.type === "contextCompaction")
    return <div className="system-item">Context summarized</div>;
  if (
    [
      "sleep",
      "enteredReviewMode",
      "exitedReviewMode",
      "imageView",
      "imageGeneration",
      "hookPrompt",
    ].includes(item.type)
  )
    return <ToolActivity item={item} />;
  return hasMeaningfulActivityDetails(item) ? (
    <ToolActivity item={item} streaming={entry.streaming} />
  ) : entry.streaming ? (
    <ToolActivity item={item} streaming />
  ) : null;
}

function UserInputPart({ part }: { part: Record<string, unknown> }) {
  const context=useContext(FileReferenceContext);
  const [preview,setPreview]=useState<string|null>(null);
  if (part.type === "text")
    return <div className="user-text">{asString(part.text)}</div>;
  if (part.type === "image") {
    const url = safeImageUrl(part.url);
    return url ? (
      <a className="user-image" href={url} target="_blank" rel="noreferrer">
        <img src={url} alt="Attached image" />
      </a>
    ) : (
      <span className="unsupported-attachment">Image attachment</span>
    );
  }
  if (part.type === "localImage"){
    const path=asString(part.path);
    const fullPath=path&&context?localReferencePath(path,context.cwd):null;
    if(fullPath&&context?.client)return <>
      <button type="button" className="markdown-local-link" onClick={()=>setPreview(fullPath)}>
        Image · {path.split("/").at(-1)}
      </button>
      {preview?<FileReferenceViewer client={context.client} path={preview}
        onClose={()=>setPreview(null)}/>:null}
    </>;
    return <span className="unsupported-attachment">Image · {path.split("/").at(-1)}</span>;
  }
  if (part.type === "audio" || part.type === "localAudio")
    return <span className="unsupported-attachment">Audio attachment</span>;
  if (part.type === "skill")
    return <span className="user-chip">Skill · {asString(part.name)}</span>;
  if (part.type === "mention")
    return <span className="user-chip">@{asString(part.name)}</span>;
  return null;
}

function ToolActivity({
  item,
  streaming = false,
}: {
  item: ThreadItem;
  streaming?: boolean;
}) {
  const type = item.type;
  const title =
    type === "mcpToolCall"
      ? [asString(item.server), asString(item.tool)]
          .filter(Boolean)
          .join(" · ") || "MCP tool"
      : type === "dynamicToolCall"
        ? `${asString(item.namespace) ? `${asString(item.namespace)}/` : ""}${asString(item.tool)}` ||
          "Dynamic tool"
        : type === "functionCallOutput"
          ? asString(item.name, "Tool output")
          : type === "hookPrompt"
            ? "Instruction hook"
            : type === "imageGeneration"
              ? "Image generation"
              : type === "imageView"
                ? "Viewed an image"
                : type === "enteredReviewMode"
                  ? "Review started"
                  : type === "exitedReviewMode"
                    ? "Review complete"
                    : type === "sleep"
                      ? "Wait"
                      : humanizeItemType(type);
  const status = activityStatus(
    item.status ?? (streaming ? "inProgress" : undefined),
    item.success,
  );
  const details = hasMeaningfulActivityDetails(item);
  const summary = (
    <>
      <span className="activity-icon tool">
        <Command size={14} />
      </span>
      <span className="activity-title">{title}</span>
      <span className={`activity-status ${status.className}`}>
        {status.label}
      </span>
    </>
  );
  if (!details)
    return <div className="activity-card activity-progress">{summary}</div>;
  return (
    <details className="activity-card">
      <summary>
        {summary}
        <ChevronDown className="activity-chevron" size={15} />
      </summary>
      <div className="activity-body">
        <pre>
          <code>{formatActivityDetails(item)}</code>
        </pre>
      </div>
    </details>
  );
}

function CollabAgentActivity({
  item,
  onOpenThread,
}: {
  item: ThreadItem;
  onOpenThread: (threadId: string, parentThreadId?: string) => void;
}) {
  const tool = asString(item.tool);
  const toolLabels: Record<string, string> = {
    spawnAgent: "Started agent",
    sendInput: "Sent task to agent",
    resumeAgent: "Resumed agent",
    wait: "Waiting for agent",
    closeAgent: "Closed agent",
    sendMessage: "Messaged agent",
    followupTask: "Added agent task",
    interruptAgent: "Interrupted agent",
    listAgents: "Checked agents",
  };
  const title = toolLabels[tool] ?? "Agent activity";
  const status = activityStatus(item.status);
  const prompt = asString(item.prompt).trim();
  const promptPreview = prompt.replace(/\s+/g, " ");
  const receiverIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds.filter(
        (threadId): threadId is string => typeof threadId === "string",
      )
    : [];
  const agentsStates = isRecord(item.agentsStates) ? item.agentsStates : {};
  const hasDetails = Boolean(
    prompt || receiverIds.length || item.model || item.reasoningEffort,
  );
  const summary = (
    <>
      {receiverIds.length ? (
        <span className="agent-identity-stack" aria-hidden="true">
          {receiverIds.slice(0, 3).map((threadId) => (
            <AgentIdentityMark
              key={threadId}
              threadId={threadId}
              fallback={threadId}
            />
          ))}
          {receiverIds.length > 3 ? (
            <span className="agent-identity-overflow">
              +{receiverIds.length - 3}
            </span>
          ) : null}
        </span>
      ) : (
        <span className="activity-icon tool">
          <Command size={14} />
        </span>
      )}
      <span className="activity-title">{title}</span>
      {promptPreview ? (
        <span className="activity-context">{promptPreview}</span>
      ) : null}
      <span className={`activity-status ${status.className}`}>
        {status.label}
      </span>
    </>
  );

  if (!hasDetails)
    return (
      <div className="activity-card activity-progress agent-activity">
        {summary}
      </div>
    );

  return (
    <details className="activity-card agent-activity">
      <summary>
        {summary}
        <ChevronDown className="activity-chevron" size={15} />
      </summary>
      {hasDetails ? (
        <div className="activity-body agent-activity-body">
          {prompt ? <p className="agent-prompt">{prompt}</p> : null}
          {item.model || item.reasoningEffort ? (
            <p className="agent-model">
              {[asString(item.model), asString(item.reasoningEffort)]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
          {receiverIds.map((threadId) => {
            const state = isRecord(agentsStates[threadId])
              ? agentsStates[threadId]
              : {};
            const agentStatus = activityStatus(
              state.status,
              undefined,
              "Linked",
            );
            return (
              <div className="agent-thread-entry" key={threadId}>
                <button
                  type="button"
                  className="agent-thread-button"
                  onClick={() =>
                    onOpenThread(threadId, asString(item.senderThreadId))
                  }
                >
                  <span className="agent-thread-name">
                    <AgentIdentityMark
                      threadId={threadId}
                      fallback={asString(state.name) || threadId}
                    />
                    <span>Agent {threadId.slice(0, 8)}</span>
                  </span>
                  <span className={`activity-status ${agentStatus.className}`}>
                    {agentStatus.label}
                  </span>
                  <ChevronRight size={14} />
                </button>
                {asString(state.message) ? (
                  <small className="agent-thread-message">
                    {asString(state.message)}
                  </small>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}
    </details>
  );
}

function SubAgentActivity({
  item,
  onOpenThread,
}: {
  item: ThreadItem;
  onOpenThread: (threadId: string, parentThreadId?: string) => void;
}) {
  const kind = asString(item.kind);
  const kindLabels: Record<string, string> = {
    started: "started",
    interacted: "updated",
    interrupted: "interrupted",
    completed: "finished",
  };
  const path = asString(item.agentPath);
  const pathLabel = path.split("/").filter(Boolean).at(-1) || "Agent";
  const threadId = asString(item.agentThreadId);
  const status = activityStatus(kind);

  return (
    <div className="activity-card activity-progress subagent-activity">
      <AgentIdentityMark
        className="subagent-identity"
        threadId={threadId}
        fallback={asString(item.agentName) || path}
      />
      <span className="activity-title">
        {pathLabel} {kindLabels[kind] ?? "updated"}
      </span>
      {item.model ? (
        <span className="activity-context">{asString(item.model)}</span>
      ) : null}
      {kind !== "completed" ? (
        <span className={`activity-status ${status.className}`}>
          {status.label}
        </span>
      ) : null}
      {threadId ? (
        <button
          type="button"
          className="agent-open-button"
          aria-label={`Open ${pathLabel} conversation`}
          title="Open agent conversation"
          onClick={() => onOpenThread(threadId)}
        >
          <ChevronRight size={14} />
        </button>
      ) : null}
    </div>
  );
}

function MarkdownContent({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeMarkdownUrl}
        components={{
          a: MarkdownLink,
          img: MarkdownImage,
          pre: MarkdownCodeBlock,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function localReferencePath(href:string,cwd:string):string|null {
  let path=href.trim();
  if(!path)return null;
  if(/^file:\/\//i.test(path)){
    try{const u=new URL(path);if(u.hostname&&u.hostname!=="localhost")return null;path=decodeURIComponent(u.pathname);}
    catch{return null;}
  }else if(/^[a-z][a-z0-9+.-]*:/i.test(path))return null;
  else{
    path=path.split("#")[0].split("?")[0];
    try{path=decodeURIComponent(path);}catch{return null;}
  }
  if(path.startsWith("/") && !path.startsWith("//"))return path;
  if(!cwd.startsWith("/")||path.startsWith("/")||path.includes("\\")||path.includes("\0"))return null;
  const elements=(cwd+"/"+path).split("/");
  const stack:string[]=[];
  for(const element of elements){if(!element||element===".")continue;if(element==="..")stack.pop();else stack.push(element);}
  return "/"+stack.join("/");
}
function safeMarkdownUrl(value:string):string{
  if(!value.trim())return "";
  if(/^codex:\/\/threads\/[a-f0-9-]{20,}$/i.test(value))return value;
  if(/^file:\/\//i.test(value)||value.startsWith("/")||value.startsWith("./")||value.startsWith("../"))return value;
  try{const url=new URL(value);return ["http:","https:"].includes(url.protocol)?url.href:"";}
  catch{return (/^[\w.-]+\/[\w./-]+$/.test(value)||
    /^[\w.-]+\.(?:md|txt|pdf|png|jpg|jpeg|webp|svg|json|csv|py|ts|tsx|js|log|yaml|yml)$/i.test(value))?value:"";}
}
function MarkdownLink({href,children}:ComponentProps<"a">){
  const context=useContext(FileReferenceContext);
  const [file,setFile]=useState<string|null>(null);
  const value=href||"";
  const threadId=value.match(/^codex:\/\/threads\/([a-f0-9-]{20,})/i)?.[1];
  if(threadId && context)
    return <button type="button" className="markdown-local-link" onClick={()=>context.openThread(threadId)}>{children}</button>;
  const web=/^https?:\/\//i.test(value) ? safeMarkdownUrl(value):"";
  if(web)return <a href={web} target="_blank" rel="noopener noreferrer">{children}</a>;
  const path=context?localReferencePath(value,context.cwd):null;
  if(path && context?.client)return <>
    <button type="button" className="markdown-local-link" title={path}
      onClick={()=>setFile(path)}>{children}</button>
    {file?<FileReferenceViewer client={context.client} path={file} onClose={()=>setFile(null)}/>:null}
  </>;
  return <span title={value||undefined}>{children}</span>;
}
function MarkdownImage({src,alt}:ComponentProps<"img">){
  const context=useContext(FileReferenceContext);
  const [file,setFile]=useState<string|null>(null);
  const url=safeImageUrl(src);
  if(url)return <a href={url} target="_blank" rel="noopener noreferrer">
    <img src={url} alt={alt||"Embedded image"} className="markdown-embedded-image" loading="lazy" referrerPolicy="no-referrer"/>
  </a>;
  const path=src&&context?localReferencePath(src,context.cwd):null;
  if(path&&context?.client)return <>
    <button type="button" className="markdown-local-link" onClick={()=>setFile(path)}>
      Preview image: {alt||path.split("/").at(-1)}
    </button>
    {file?<FileReferenceViewer client={context.client} path={file} onClose={()=>setFile(null)}/>:null}
  </>;
  return <span title={src||undefined}>{alt||"Image reference"}</span>;
}

function ApprovalDialog({
  prompt,
  unknown,
  answers,
  setAnswers,
  onReply,
  onRejectUnknown,
}: {
  prompt: ApprovalPrompt;
  unknown: boolean;
  answers: Record<string, string[]>;
  setAnswers: (answers: Record<string, string[]>) => void;
  onReply: (result: unknown) => void;
  onRejectUnknown: () => void;
}) {
  const params = prompt.params;
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  const method = prompt.method;
  const decisionEntries = Array.isArray(params.availableDecisions)
    ? params.availableDecisions
    : null;
  if (method === "mcpServer/elicitation/request")
    return (
      <McpServerElicitationDialog
        key={String(prompt.id)}
        prompt={prompt}
        onReply={onReply}
      />
    );
  if (unknown)
    return (
      <div className="modal-scrim">
        <div
          className="approval-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="approval-icon unknown">
            <CircleHelp size={19} />
          </div>
          <p className="eyebrow">UNSUPPORTED REQUEST</p>
          <h2 id="approval-title">Codex needs a response</h2>
          <p className="approval-description">
            This client does not have a handler for this server request. Review
            its details, then decline it so the turn can continue.
          </p>
          <div className="request-details">
            <strong>{method}</strong>
            <pre>{formatUnknown(params)}</pre>
          </div>
          <div className="approval-actions">
            <button className="secondary-action" onClick={onRejectUnknown}>
              Decline request
            </button>
          </div>
        </div>
      </div>
    );

  if (method === "item/tool/requestUserInput") {
    const questions = Array.isArray(params.questions)
      ? (params.questions as Array<Record<string, unknown>>)
      : [];
    return (
      <div className="modal-scrim">
        <div
          className="approval-modal input-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="approval-icon input">
            <MessageSquareText size={19} />
          </div>
          <p className="eyebrow">CODEX NEEDS YOUR INPUT</p>
          <h2 id="approval-title">A few questions</h2>
          <div className="questions-list">
            {questions.map((question) => (
              <div className="question-block" key={asString(question.id)}>
                <div className="question-heading" role="heading" aria-level={3}>
                  <MarkdownContent
                    text={asString(question.header, "Question")}
                  />
                </div>
                <div className="question-copy">
                  <MarkdownContent text={asString(question.question)} />
                </div>
                {Array.isArray(question.options) && question.options.length ? (
                  <div className="question-options">
                    {(question.options as Array<Record<string, unknown>>).map(
                      (option) => {
                        const label = asString(option.label);
                        const selected = (
                          answers[asString(question.id)] ?? []
                        ).includes(label);
                        return (
                          <div
                            key={label}
                            className={`question-option ${selected ? "selected" : ""}`}
                          >
                            <button
                              type="button"
                              className="question-option-select"
                              aria-label={`${selected ? "Unselect" : "Select"} ${label}`}
                              aria-pressed={selected}
                              onClick={() =>
                                setAnswers({
                                  ...answers,
                                  [asString(question.id)]: selected
                                    ? (
                                        answers[asString(question.id)] ?? []
                                      ).filter((entry) => entry !== label)
                                    : [
                                        ...(answers[asString(question.id)] ??
                                          []),
                                        label,
                                      ],
                                })
                              }
                            >
                              <span className="option-check">
                                {selected ? <Check size={13} /> : null}
                              </span>
                            </button>
                            <div className="question-option-content">
                              <div className="question-option-label">
                                <MarkdownContent text={label} />
                              </div>
                              {asString(option.description) ? (
                                <div className="question-option-description">
                                  <MarkdownContent
                                    text={asString(option.description)}
                                  />
                                </div>
                              ) : null}
                            </div>
                          </div>
                        );
                      },
                    )}
                  </div>
                ) : null}
                {question.isOther ||
                !Array.isArray(question.options) ||
                question.options.length === 0 ? (
                  <input
                    className="other-answer"
                    type={question.isSecret ? "password" : "text"}
                    aria-label={`${question.isOther && Array.isArray(question.options) && question.options.length ? "Other answer" : "Answer"} for ${asString(question.header)}`}
                    placeholder={
                      question.isOther &&
                      Array.isArray(question.options) &&
                      question.options.length
                        ? "Other answer"
                        : "Your answer"
                    }
                    value={
                      (answers[asString(question.id)] ?? [])
                        .find((entry) => entry.startsWith("other:"))
                        ?.slice(6) ?? ""
                    }
                    onChange={(event) => {
                      const rest = (
                        answers[asString(question.id)] ?? []
                      ).filter((entry) => !entry.startsWith("other:"));
                      setAnswers({
                        ...answers,
                        [asString(question.id)]: event.target.value
                          ? [...rest, `other:${event.target.value}`]
                          : rest,
                      });
                    }}
                  />
                ) : null}
              </div>
            ))}
          </div>
          <div className="approval-actions">
            <button
              className="secondary-action"
              onClick={() => onReply({ answers: {} })}
            >
              Skip
            </button>
            <button
              className="primary-action"
              onClick={() => {
                const normalized = Object.fromEntries(
                  Object.entries(answers).map(([id, choices]) => [
                    id,
                    choices.map((choice) =>
                      choice.startsWith("other:") ? choice.slice(6) : choice,
                    ),
                  ]),
                );
                onReply({
                  answers: Object.fromEntries(
                    Object.entries(normalized).map(([id, values]) => [
                      id,
                      { answers: values },
                    ]),
                  ),
                });
              }}
            >
              Send answers
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (method === "item/tool/call") {
    const toolName =
      [params.namespace, params.tool].filter(Boolean).join("/") ||
      "unnamed tool";
    return (
      <div className="modal-scrim">
        <div
          className="approval-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="approval-icon unknown">
            <Command size={19} />
          </div>
          <p className="eyebrow">CLIENT TOOL REQUEST</p>
          <h2 id="approval-title">Tool unavailable here</h2>
          <p className="approval-description">
            The daemon requested a client-owned tool. This web client does not
            execute dynamic tools.
          </p>
          <div className="request-details">
            <strong>{toolName}</strong>
            <pre>{formatUnknown(params.arguments)}</pre>
          </div>
          <div className="approval-actions">
            <button
              className="primary-action"
              onClick={() =>
                onReply({
                  success: false,
                  contentItems: [
                    {
                      type: "inputText",
                      text: "This client does not support this dynamic tool call.",
                    },
                  ],
                })
              }
            >
              Return unsupported response
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (method === "item/commandExecution/requestApproval") {
    const choices = decisionEntries?.length
      ? decisionEntries
      : ["accept", "acceptForSession", "decline", "cancel"];
    return (
      <div className="modal-scrim">
        <div
          className="approval-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="approval-icon command">
            <Terminal size={19} />
          </div>
          <p className="eyebrow">COMMAND APPROVAL</p>
          <h2 id="approval-title">Allow this command?</h2>
          {params.reason ? (
            <p className="approval-description">{asString(params.reason)}</p>
          ) : null}
          <div className="request-details">
            <div className="approval-meta">
              <span>Working directory</span>
              <code>{asString(params.cwd, "Not provided")}</code>
            </div>
            <pre>{asString(params.command, "Command details unavailable")}</pre>
            {Array.isArray(params.commandActions) &&
            params.commandActions.length ? (
              <details>
                <summary>Command actions</summary>
                <pre>{formatUnknown(params.commandActions)}</pre>
              </details>
            ) : null}
          </div>
          <div className="approval-actions approval-actions-wrap">
            {choices.map((choice, index) => (
              <button
                className={
                  decisionName(choice) === "decline" ||
                  decisionName(choice) === "cancel"
                    ? "secondary-action"
                    : index === 0
                      ? "primary-action"
                      : "secondary-action"
                }
                key={JSON.stringify(choice)}
                onClick={() => onReply({ decision: choice })}
              >
                {decisionLabel(choice)}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (method === "item/fileChange/requestApproval") {
    const context = [
      asString(params.reason),
      params.grantRoot ? `Requested root: ${asString(params.grantRoot)}` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <div className="modal-scrim">
        <div
          className="approval-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="approval-icon file">
            <FilePlus2 size={19} />
          </div>
          <p className="eyebrow">FILE CHANGE APPROVAL</p>
          <h2 id="approval-title">Allow these file changes?</h2>
          <p className="approval-description">
            {context || "Codex is requesting permission to write files."}
          </p>
          <div className="request-details">
            <strong>Thread {asString(params.threadId).slice(0, 12)}</strong>
            <p>
              Review the proposed patch in the conversation before allowing the
              write.
            </p>
          </div>
          <div className="approval-actions">
            <button
              className="secondary-action"
              onClick={() => onReply({ decision: "decline" })}
            >
              Decline
            </button>
            <button
              className="secondary-action"
              onClick={() => onReply({ decision: "acceptForSession" })}
            >
              Allow this session
            </button>
            <button
              className="primary-action"
              onClick={() => onReply({ decision: "accept" })}
            >
              Allow once
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (method === "item/permissions/requestApproval") {
    const permissions = isRecord(params.permissions) ? params.permissions : {};
    return (
      <div className="modal-scrim">
        <div
          className="approval-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="approval-title"
          tabIndex={-1}
          ref={dialogRef}
        >
          <div className="approval-icon permission">
            <Shield size={19} />
          </div>
          <p className="eyebrow">ADDITIONAL PERMISSIONS</p>
          <h2 id="approval-title">Review requested access</h2>
          {params.reason ? (
            <p className="approval-description">{asString(params.reason)}</p>
          ) : null}
          <div className="request-details">
            <div className="approval-meta">
              <span>Working directory</span>
              <code>{asString(params.cwd, "Not provided")}</code>
            </div>
            <pre>{formatUnknown(permissions)}</pre>
          </div>
          <div className="approval-actions">
            <button
              className="secondary-action"
              onClick={() => onReply({ permissions: {}, scope: "turn" })}
            >
              Decline
            </button>
            <button
              className="secondary-action"
              onClick={() => onReply({ permissions, scope: "session" })}
            >
              Allow this session
            </button>
            <button
              className="primary-action"
              onClick={() => onReply({ permissions, scope: "turn" })}
            >
              Allow this turn
            </button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function McpServerElicitationDialog({
  prompt,
  onReply,
}: {
  prompt: ApprovalPrompt;
  onReply: (result: unknown) => void;
}) {
  const params = prompt.params;
  const mode = asString(params.mode);
  const serverName = asString(params.serverName, "MCP server");
  const meta = isRecord(params._meta) ? params._meta : {};
  const approval = meta.codex_approval_kind === "mcp_tool_call";
  const fields =
    mode === "form" ? parseMcpElicitationFields(params.requestedSchema) : null;
  const safeUrl =
    mode === "url" ? safeElicitationUrl(params.url, serverName) : null;
  const [values, setValues] = useState(() =>
    initialMcpElicitationValues(fields ?? []),
  );
  const [validationError, setValidationError] = useState("");
  const [openedUrl, setOpenedUrl] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const respond = (
    action: McpServerElicitationResponse["action"],
    content: unknown = null,
    responseMeta: Record<string, unknown> | null = null,
  ) => {
    onReply({ action, content, _meta: responseMeta });
  };

  const frame = (eyebrow: string, title: string, children: ReactNode) => (
    <div className="modal-scrim">
      <div
        className="approval-modal elicitation-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="approval-icon input">
          <MessageSquareText size={19} />
        </div>
        <p className="eyebrow">{eyebrow}</p>
        <h2 id="approval-title">{title}</h2>
        <p className="approval-description">{serverName}</p>
        {children}
      </div>
    </div>
  );

  if (mode === "form" && fields) {
    const toolName = asString(meta.tool_name);
    const title = asString(
      meta.tool_title,
      approval ? "Approve MCP tool call?" : "MCP server needs information",
    );
    const persistChoices = approval
      ? ["session", "always"].filter((scope) =>
          approvalSupportsPersist(meta, scope),
        )
      : [];
    const submit = (persist: string | null = null) => {
      const result = validateMcpElicitationValues(fields, values);
      if (result.error) {
        setValidationError(result.error);
        return;
      }
      respond("accept", result.content ?? {}, persist ? { persist } : null);
    };

    return frame(
      approval ? "MCP TOOL APPROVAL" : "MCP SERVER REQUEST",
      title,
      <>
        {toolName ? <p className="elicitation-tool-name">{toolName}</p> : null}
        {params.message ? (
          <p className="approval-description">{asString(params.message)}</p>
        ) : null}
        {approval && meta.tool_params_display !== undefined ? (
          <div className="request-details elicitation-preview">
            <strong>Requested action</strong>
            <pre>{formatUnknown(meta.tool_params_display)}</pre>
          </div>
        ) : null}
        {fields.length ? (
          <div className="elicitation-fields">
            {fields.map((field) => (
              <label className="elicitation-field" key={field.id}>
                <span className="elicitation-label">
                  {field.label}
                  {field.required ? " *" : ""}
                </span>
                {field.description ? (
                  <span className="elicitation-help">{field.description}</span>
                ) : null}
                {field.kind === "boolean" ? (
                  <select
                    value={
                      typeof values[field.id] === "boolean"
                        ? String(values[field.id])
                        : ""
                    }
                    onChange={(event) =>
                      setValues({
                        ...values,
                        [field.id]:
                          event.target.value === ""
                            ? ""
                            : event.target.value === "true",
                      })
                    }
                  >
                    <option value="">Choose…</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : null}
                {field.kind === "string" ? (
                  <input
                    type="text"
                    value={
                      typeof values[field.id] === "string"
                        ? (values[field.id] as string)
                        : ""
                    }
                    minLength={field.minLength}
                    maxLength={field.maxLength}
                    onChange={(event) =>
                      setValues({ ...values, [field.id]: event.target.value })
                    }
                  />
                ) : null}
                {field.kind === "number" ? (
                  <input
                    type="number"
                    step={field.integer ? 1 : "any"}
                    min={field.minimum}
                    max={field.maximum}
                    value={
                      typeof values[field.id] === "string"
                        ? (values[field.id] as string)
                        : ""
                    }
                    onChange={(event) =>
                      setValues({ ...values, [field.id]: event.target.value })
                    }
                  />
                ) : null}
                {field.kind === "single" ? (
                  <select
                    value={
                      typeof values[field.id] === "string" &&
                      field.options?.some(
                        (option) => option.value === values[field.id],
                      )
                        ? JSON.stringify(values[field.id])
                        : ""
                    }
                    onChange={(event) => {
                      const selected = event.target.value;
                      setValues({
                        ...values,
                        [field.id]: selected ? JSON.parse(selected) : null,
                      });
                    }}
                  >
                    <option value="">Choose…</option>
                    {field.options?.map((option) => (
                      <option
                        value={JSON.stringify(option.value)}
                        key={option.value}
                      >
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {field.kind === "multi" ? (
                  <span className="elicitation-checkboxes">
                    {field.options?.map((option) => {
                      const selectedValues = values[field.id];
                      const selected =
                        Array.isArray(selectedValues) &&
                        selectedValues.includes(option.value);
                      return (
                        <label
                          className="elicitation-checkbox"
                          key={option.value}
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => {
                              const currentValue = values[field.id];
                              const current = Array.isArray(currentValue)
                                ? currentValue
                                : [];
                              setValues({
                                ...values,
                                [field.id]: selected
                                  ? current.filter(
                                      (entry) => entry !== option.value,
                                    )
                                  : [...current, option.value],
                              });
                            }}
                          />
                          {option.label}
                        </label>
                      );
                    })}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        ) : null}
        {approval && meta.tool_description ? (
          <details className="elicitation-raw-details">
            <summary>Tool description</summary>
            <p>{asString(meta.tool_description)}</p>
          </details>
        ) : null}
        {approval && meta.tool_params !== undefined ? (
          <details className="elicitation-raw-details">
            <summary>Full tool parameters</summary>
            <pre>{formatUnknown(meta.tool_params)}</pre>
          </details>
        ) : null}
        {validationError ? (
          <p className="elicitation-error" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="approval-actions approval-actions-wrap">
          <button
            className="secondary-action"
            onClick={() => respond("decline")}
          >
            Decline
          </button>
          <button
            className="secondary-action"
            onClick={() => respond("cancel")}
          >
            Cancel
          </button>
          {persistChoices.includes("session") ? (
            <button
              className="secondary-action"
              onClick={() => submit("session")}
            >
              Allow this session
            </button>
          ) : null}
          {persistChoices.includes("always") ? (
            <button
              className="secondary-action"
              onClick={() => submit("always")}
            >
              Always allow
            </button>
          ) : null}
          <button className="primary-action" onClick={() => submit()}>
            Allow once
          </button>
        </div>
      </>,
    );
  }

  if (mode === "url") {
    let host = "Invalid or unsupported URL";
    if (safeUrl) {
      try {
        host = new URL(safeUrl).host;
      } catch {
        host = "Invalid or unsupported URL";
      }
    }
    return frame(
      "MCP SERVER LINK",
      "Continue in the browser?",
      <>
        <p className="approval-description">{asString(params.message)}</p>
        <div className="request-details">
          <strong>{host}</strong>
        </div>
        {safeUrl ? (
          <div className="approval-actions approval-actions-wrap">
            <button
              className="secondary-action"
              onClick={() => respond("decline")}
            >
              Decline
            </button>
            <button
              className="secondary-action"
              onClick={() => respond("cancel")}
            >
              Cancel
            </button>
            {openedUrl ? (
              <button
                className="primary-action"
                onClick={() => respond("accept")}
              >
                I completed the request
              </button>
            ) : (
              <button
                className="primary-action"
                onClick={() => {
                  window.open(safeUrl, "_blank", "noopener,noreferrer");
                  setOpenedUrl(true);
                }}
              >
                Open link
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="elicitation-error">
              This link does not meet the client’s HTTPS safety rules.
            </p>
            <div className="approval-actions">
              <button
                className="secondary-action"
                onClick={() => respond("decline")}
              >
                Decline request
              </button>
            </div>
          </>
        )}
      </>,
    );
  }

  const title =
    mode === "openai/userVerification"
      ? asString(params.title, "User verification is not supported here")
      : "This elicitation mode is not supported here";
  return frame(
    "UNSUPPORTED MCP MODE",
    title,
    <>
      {params.description ? (
        <p className="approval-description">{asString(params.description)}</p>
      ) : null}
      {params.message ? (
        <p className="approval-description">{asString(params.message)}</p>
      ) : null}
      <details className="elicitation-raw-details">
        <summary>Request details</summary>
        <pre>{formatUnknown(params)}</pre>
      </details>
      <div className="approval-actions">
        <button className="secondary-action" onClick={() => respond("decline")}>
          Decline unsupported request
        </button>
      </div>
    </>,
  );
}

function decisionName(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return Object.keys(value)[0] ?? "choice";
  return "choice";
}

function decisionLabel(value: unknown): string {
  const labels: Record<string, string> = {
    accept: "Allow once",
    acceptForSession: "Allow this session",
    decline: "Decline",
    cancel: "Cancel",
    acceptWithExecpolicyAmendment: "Allow and remember rule",
    applyNetworkPolicyAmendment: "Apply network rule",
  };
  return labels[decisionName(value)] ?? decisionName(value);
}

function updateItem(
  items: TimelineItem[],
  itemId: string,
  update: (item: ThreadItem) => ThreadItem,
): TimelineItem[] {
  if (!itemId) return items;
  const index = items.findIndex((entry) => entry.item.id === itemId);
  if (index < 0) return items;
  const next = [...items];
  next[index] = {
    ...next[index],
    item: update(next[index].item),
    streaming: true,
  };
  return next;
}

function mergeHistoryWithLive(
  history: TimelineItem[],
  live: TimelineItem[],
  liveIds: Set<string>,
): TimelineItem[] {
  const byId = new Map(history.map((entry) => [entry.item.id, entry]));
  for (const entry of live)
    if (liveIds.has(entry.item.id)) byId.set(entry.item.id, entry);
  return Array.from(byId.values()).sort(
    (a, b) => (a.startedAtMs ?? 0) - (b.startedAtMs ?? 0),
  );
}

function groupTimelineItems(items: TimelineItem[]): {
  groups: TimelineGroup[];
  latestMessageOwnerKey: string | null;
} {
  const groups: TimelineGroup[] = [];
  let pendingActivity: TimelineItem[] = [];
  let pendingResponseKey: string | null = null;
  let currentResponseKey: string | null = null;
  let currentUserResponseCanBindTurn = false;
  const responseKeysByTurn = new Map<string, string>();
  const responseKeyFor = (entry: TimelineItem) => {
    const responseKey = entry.turnId
      ? `turn:${entry.turnId}`
      : `user:${entry.item.id}`;
    if (entry.turnId) responseKeysByTurn.set(entry.turnId, responseKey);
    return responseKey;
  };
  const flushPendingActivity = () => {
    if (pendingActivity.length && pendingResponseKey) {
      const first = pendingActivity[0];
      groups.push({
        kind: "activity",
        key: `activity:${first.turnId || "no-turn"}:${first.item.id}`,
        responseKey: pendingResponseKey,
        defaultOwnerKey: `pending:${pendingResponseKey}`,
        entries: pendingActivity,
      });
    }
    pendingActivity = [];
    pendingResponseKey = null;
  };

  for (const entry of items) {
    if (entry.item.type === "userMessage") {
      flushPendingActivity();
      currentResponseKey = responseKeyFor(entry);
      currentUserResponseCanBindTurn = !entry.turnId;
      groups.push({
        kind: "message",
        key: `item:${entry.turnId}:${entry.item.id}`,
        entry,
        responseKey: currentResponseKey,
      });
      continue;
    }

    if (entry.turnId) {
      const turnResponseKey = responseKeysByTurn.get(entry.turnId);
      if (turnResponseKey) {
        currentResponseKey = turnResponseKey;
        currentUserResponseCanBindTurn = false;
      } else if (currentUserResponseCanBindTurn && currentResponseKey) {
        responseKeysByTurn.set(entry.turnId, currentResponseKey);
        currentUserResponseCanBindTurn = false;
      } else {
        currentResponseKey = `turn:${entry.turnId}`;
        responseKeysByTurn.set(entry.turnId, currentResponseKey);
        currentUserResponseCanBindTurn = false;
      }
    }

    if (entry.item.type === "contextCompaction") {
      flushPendingActivity();
      groups.push({
        kind: "message",
        key: `item:${entry.turnId}:${entry.item.id}`,
        entry,
        responseKey: currentResponseKey,
      });
    } else if (entry.item.type === "agentMessage") {
      flushPendingActivity();
      currentResponseKey ??= `assistant:${entry.item.id}`;
      groups.push({
        kind: "message",
        key: `item:${entry.turnId}:${entry.item.id}`,
        entry,
        responseKey: currentResponseKey,
      });
    } else {
      if (!currentResponseKey) {
        flushPendingActivity();
        groups.push({
          kind: "message",
          key: `item:${entry.turnId}:${entry.item.id}`,
          entry,
          responseKey: null,
        });
        continue;
      }
      if (
        pendingActivity.length > 0 &&
        pendingResponseKey !== currentResponseKey
      )
        flushPendingActivity();
      pendingResponseKey = currentResponseKey;
      pendingActivity.push(entry);
    }
  }
  flushPendingActivity();

  const latestAssistantByResponse = new Map<string, string>();
  const pendingGroupIndexesByResponse = new Map<string, number[]>();
  let latestMessageOwnerKey: string | null = null;
  for (const [index, group] of groups.entries()) {
    if (group.kind === "activity") {
      const assistantOwner = latestAssistantByResponse.get(group.responseKey);
      group.defaultOwnerKey = assistantOwner ?? `pending:${group.responseKey}`;
      if (!assistantOwner) {
        const pending =
          pendingGroupIndexesByResponse.get(group.responseKey) ?? [];
        pending.push(index);
        pendingGroupIndexesByResponse.set(group.responseKey, pending);
      }
      latestMessageOwnerKey = group.defaultOwnerKey;
      continue;
    }

    if (group.entry.item.type === "userMessage") {
      if (group.responseKey)
        latestMessageOwnerKey = `pending:${group.responseKey}`;
      continue;
    }

    if (group.entry.item.type !== "agentMessage" || !group.responseKey)
      continue;
    const assistantOwner = `assistant:${group.responseKey}:${group.entry.item.id}`;
    const pendingIndexes = pendingGroupIndexesByResponse.get(group.responseKey);
    if (pendingIndexes) {
      for (const pendingIndex of pendingIndexes) {
        const pendingGroup = groups[pendingIndex];
        if (pendingGroup.kind === "activity")
          pendingGroup.defaultOwnerKey = assistantOwner;
      }
      pendingGroupIndexesByResponse.delete(group.responseKey);
    }
    latestAssistantByResponse.set(group.responseKey, assistantOwner);
    latestMessageOwnerKey = assistantOwner;
  }

  return { groups, latestMessageOwnerKey };
}

function formatUnknown(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function hasActivityValue(value: unknown): boolean {
  if (typeof value === "string") return Boolean(value.trim());
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasActivityValue);
  if (isRecord(value))
    return Object.entries(value).some(
      ([key, entry]) =>
        key !== "id" && key !== "type" && hasActivityValue(entry),
    );
  return false;
}

function hasMeaningfulActivityDetails(item: ThreadItem): boolean {
  const metadata = new Set(["id", "type", "status", "durationMs", "success"]);
  return Object.entries(item).some(
    ([key, value]) => !metadata.has(key) && hasActivityValue(value),
  );
}

function formatActivityDetails(item: ThreadItem): string {
  return formatUnknown(
    Object.fromEntries(
      Object.entries(item).filter(([key]) => key !== "id" && key !== "type"),
    ),
  );
}

function humanizeItemType(type: string): string {
  return capitalize(
    type.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]/g, " "),
  );
}

function activityStatus(
  value: unknown,
  success?: unknown,
  fallback = "Details",
): { label: string; className: string } {
  const raw = asString(value);
  const labels: Record<string, { label: string; className: string }> = {
    inProgress: { label: "Running", className: "running" },
    running: { label: "Running", className: "running" },
    pendingInit: { label: "Starting", className: "running" },
    started: { label: "Running", className: "running" },
    interacted: { label: "Active", className: "running" },
    completed: { label: "Complete", className: "complete" },
    complete: { label: "Complete", className: "complete" },
    interrupted: { label: "Interrupted", className: "interrupted" },
    failed: { label: "Failed", className: "failed" },
    declined: { label: "Declined", className: "failed" },
    errored: { label: "Failed", className: "failed" },
    shutdown: { label: "Stopped", className: "interrupted" },
    notFound: { label: "Unavailable", className: "failed" },
  };
  if (labels[raw]) return labels[raw];
  if (success === false) return labels.failed;
  if (success === true) return labels.completed;
  return raw
    ? { label: humanizeItemType(raw), className: "" }
    : { label: fallback, className: "" };
}

function capitalize(value: string): string {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}
