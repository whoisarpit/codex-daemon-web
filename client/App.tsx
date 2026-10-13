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
  ImagePlus,
  LoaderCircle,
  Menu,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Shield,
  Square,
  Sun,
  Terminal,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RpcClient, type ConnectionState } from "./protocol";
import type {
  ApprovalPrompt,
  DaemonStatus,
  ModelOption,
  RpcError,
  ThreadDetails,
  ThreadItem,
  ThreadItemEntry,
  ThreadSummary,
  UserInput,
} from "./types";
import "./styles.css";

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
type AppNotice = { tone: "info" | "error" | "success"; text: string };

const selectedThreadKey = "codex-desk.selected-thread";
const themeChoiceKey = "codex-daemon-web-theme";
const maxTurnRequestBytes = 900 * 1024;
const maxAttachmentBytes = 700 * 1024;
const maxCompressedImageBytes = 320 * 1024;
const maxImageFileBytes = 20 * 1024 * 1024;
const maxImageCount = 4;

function readThemeChoice(): ThemeChoice {
  try {
    const value = localStorage.getItem(themeChoiceKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
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

function userInputFromDraft(
  text: string,
  uploads: PendingUpload[],
): UserInput[] {
  const input: UserInput[] = [];
  if (text.trim())
    input.push({ type: "text", text: text.trim(), text_elements: [] });
  for (const upload of uploads)
    input.push({ type: "image", url: upload.dataUrl, detail: "auto" });
  return input;
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
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>(readThemeChoice);
  const [booting, setBooting] = useState(true);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [token, setToken] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [notice, setNotice] = useState<AppNotice | null>(null);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const threadsRef = useRef<ThreadSummary[]>([]);
  const [archivedThreads, setArchivedThreads] = useState(false);
  const [threadCursor, setThreadCursor] = useState<string | null>(null);
  const [threadSearch, setThreadSearch] = useState("");
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(
    null,
  );
  const [threadDetails, setThreadDetails] = useState<ThreadDetails | null>(
    null,
  );
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
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [cwd, setCwd] = useState("");
  const [approvalPolicy, setApprovalPolicy] = useState("");
  const [sandboxMode, setSandboxMode] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [composer, setComposer] = useState("");
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
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [approvalQueue, setApprovalQueue] = useState<ApprovalPrompt[]>([]);
  const [questionAnswers, setQuestionAnswers] = useState<
    Record<string, string[]>
  >({});
  const { client, connection, connectionMessage, attach, detach } = useRpc();
  const handlersRef = useRef({
    onNotification: (_method: string, _params: Record<string, unknown>) => {},
    onServerRequest: (_request: ApprovalPrompt) => {},
    onDisconnected: () => {},
    onReady: (_rpc: RpcClient) => {},
  });
  const timelineRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollWasNearBottom = useRef(true);
  const loadVersionRef = useRef(0);
  const threadNavigationRef = useRef(false);
  const sessionExpiredRef = useRef(false);
  const sessionProbeEpochRef = useRef(0);
  const sessionProbeSequenceRef = useRef(0);
  const sessionProbeInFlightRef = useRef<number | null>(null);
  const sessionProbeLastAtRef = useRef(0);
  const approvalPrompt = approvalQueue[0] ?? null;
  const newConversationRef = useRef<
    (historyMode?: "push" | "replace" | "none") => void
  >(() => {});

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

  const refreshThreads = useCallback(
    async (rpc: RpcClient, archived = archivedThreads, append = false) => {
      try {
        const result = await rpc.request<{
          data: ThreadSummary[];
          nextCursor: string | null;
        }>("thread/list", {
          limit: 40,
          sortKey: archived ? "updated_at" : "recency_at",
          sortDirection: "desc",
          archived,
          ...(append && threadCursor ? { cursor: threadCursor } : {}),
        });
        setThreads((current) =>
          mergeThreadPage(current, result.data, append, !archived),
        );
        setThreadCursor(result.nextCursor);
      } catch (error) {
        setNotice({
          tone: "error",
          text: `Could not load conversations: ${shortError(error)}`,
        });
      }
    },
    [archivedThreads, threadCursor],
  );

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

  const handleNotification = useCallback(
    (method: string, params: Record<string, unknown>) => {
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
        const name = asString(params.name);
        setThreads((current) =>
          current.map((entry) =>
            entry.id === threadId ? { ...entry, name } : entry,
          ),
        );
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
        setApprovalQueue((current) =>
          current.filter((prompt) => prompt.id !== params.requestId),
        );
        return;
      }

      const threadId = asString(params.threadId);
      if (method === "turn/started" && client)
        void refreshThreads(client, archivedThreads, false);
      if (threadId && threadId !== selectedRef.current) return;

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
          setTurnActive(false);
          setActiveTurnId(null);
        }
        return;
      }
      if (method === "thread/status/changed") {
        const status = params.status;
        const isActive = isRecord(status) && status.type === "active";
        setTurnActive(isActive);
        if (!isActive) setActiveTurnId(null);
        return;
      }

      if (method === "item/started" || method === "item/completed") {
        if (!isRecord(params.item) || typeof params.item.type !== "string")
          return;
        const next = params.item as ThreadItem;
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
    [activeTurnId, archivedThreads, client, refreshThreads],
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
    setApprovalQueue((current) => [...current, request]);
  }, []);

  const openThread = useCallback(
    async (rpc: RpcClient, threadId: string, announce = false) => {
      const version = ++loadVersionRef.current;
      selectedRef.current = threadId;
      if (announce) setMobileSidebarOpen(false);
      const summary =
        threadsRef.current.find((thread) => thread.id === threadId) ?? null;
      setSelectedThread(summary);
      setItems([]);
      setThreadDetails(null);
      setLoadingThread(true);
      setItemCursor(null);
      setActiveTurnId(null);
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
        setThreadDetails(response);
        setCwd(response.cwd || summary?.cwd || "");
        setModel(response.model || summary?.model || "");
        setEffort(response.reasoningEffort || summary?.reasoningEffort || "");
        setApprovalPolicy("");
        setSandboxMode("");
        setTurnActive(
          isRecord(response.thread.status) &&
            response.thread.status.type === "active",
        );
        if (response.thread.canAcceptDirectInput === false)
          setShowSettings(false);
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
            name: response.thread.name ?? existing?.name ?? null,
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
        if (activeTurn) setActiveTurnId(activeTurn.id);
        setLoadingThread(false);
        sessionStorage.setItem(selectedThreadKey, threadId);
        requestAnimationFrame(() => {
          const view = timelineRef.current;
          if (view) view.scrollTop = view.scrollHeight;
        });
      } catch (error) {
        if (version !== loadVersionRef.current) return;
        setLoadingThread(false);
        setNotice({
          tone: "error",
          text: `Could not open conversation: ${shortError(error)}`,
        });
      }
    },
    [updateThreadTrail],
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
    sessionStorage.removeItem(selectedThreadKey);
    setSelectedThread(null);
    setThreadDetails(null);
    setItems([]);
    itemsRef.current = [];
    liveItemsRef.current.clear();
    setItemCursor(null);
    setLoadingThread(false);
    setActiveTurnId(null);
    setTurnActive(false);
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
        newConversationRef.current();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

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
  const filteredThreads = useMemo(() => {
    const query = threadSearch.toLowerCase().trim();
    if (!query) return threads;
    return threads.filter((thread) =>
      `${titleFor(thread)} ${thread.preview} ${thread.cwd}`
        .toLowerCase()
        .includes(query),
    );
  }, [threadSearch, threads]);
  const timelineGrouping = useMemo(() => groupTimelineItems(items), [items]);

  const sendMessage = async (
    event?: FormEvent<HTMLFormElement>,
    action: "auto" | "steer" = "auto",
  ) => {
    event?.preventDefault();
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
    let threadId = selectedThread?.id;
    const threadIdAtSend = threadId ?? null;
    const turnIdAtSend = activeTurnId;
    try {
      const input = userInputFromDraft(composerAtSend, uploadsAtSend);

      if (shouldSteer) {
        const attemptKey = JSON.stringify([
          threadIdAtSend,
          turnIdAtSend,
          composerAtSend,
          uploadsAtSend.map((upload) => upload.id),
        ]);
        const clientUserMessageId =
          steerAttemptRef.current?.key === attemptKey
            ? steerAttemptRef.current.clientUserMessageId
            : crypto.randomUUID();
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
        await client.request<{ turnId: string }>("turn/steer", steerParams);
        void refreshThreads(client, archivedThreads, false);
        if (
          selectedRef.current === threadIdAtSend &&
          loadVersionRef.current === loadVersionAtSend
        ) {
          const composerUnchanged =
            (composerRef.current?.value ?? composerAtSend) === composerAtSend;
          if (composerUnchanged) {
            setComposer("");
            if (composerRef.current) composerRef.current.style.height = "39px";
          }
          clearUploadsIfUnchanged(uploadsAtSend);
          if (composerUnchanged && uploadsRef.current.length === 0)
            steerAttemptRef.current = null;
        }
        setNotice({
          tone: "success",
          text: "Direction sent to the active turn.",
        });
        return;
      }

      const turnParams: Record<string, unknown> = {
        threadId: threadId ?? "00000000-0000-0000-0000-000000000000",
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

      if (!threadId) {
        const startParams: Record<string, unknown> = {};
        if (model) startParams.model = model;
        if (cwd.trim()) startParams.cwd = cwd.trim();
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
      if (selectedRef.current === threadId) {
        setActiveTurnId(response.turn.id);
        setTurnActive(response.turn.status === "inProgress");
        if ((composerRef.current?.value ?? composerAtSend) === composerAtSend) {
          setComposer("");
          if (composerRef.current) composerRef.current.style.height = "39px";
        }
        clearUploadsIfUnchanged(uploadsAtSend);
        setShowSettings(false);
      }
    } catch (error) {
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
    if (queueingRef.current || sending || compressingUploadsRef.current) return;
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
    const input = userInputFromDraft(textAtQueue, uploadsAtQueue);
    const attemptKey = JSON.stringify([
      threadIdAtQueue,
      textAtQueue,
      uploadsAtQueue.map((upload) => upload.id),
    ]);
    const clientUserMessageId =
      queueAttemptRef.current?.key === attemptKey
        ? queueAttemptRef.current.clientUserMessageId
        : crypto.randomUUID();
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
    try {
      const result = await client.request<{
        queuedSubmission: { id: string };
      }>("thread/queue/add", params);
      if (!result.queuedSubmission?.id)
        throw new Error("The daemon did not confirm the queued reply.");
      let clearedDraft = false;
      if (
        selectedRef.current === threadIdAtQueue &&
        loadVersionRef.current === loadVersionAtQueue
      ) {
        const composerUnchanged =
          (composerRef.current?.value ?? textAtQueue) === textAtQueue;
        const uploadIdsAtQueue = uploadsAtQueue
          .map((upload) => upload.id)
          .join("\u0000");
        const uploadsUnchanged =
          uploadsRef.current.map((upload) => upload.id).join("\u0000") ===
          uploadIdsAtQueue;
        if (composerUnchanged) {
          setComposer("");
          if (composerRef.current) composerRef.current.style.height = "39px";
        }
        clearUploadsIfUnchanged(uploadsAtQueue);
        clearedDraft = composerUnchanged && uploadsUnchanged;
      }
      if (clearedDraft) queueAttemptRef.current = null;
      setNotice({
        tone: "success",
        text: `Reply queued for ${threadTitleAtQueue}. It will run after the active turn.`,
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not confirm that the reply was queued. Check the thread queue before retrying. ${shortError(error)}`,
      });
    } finally {
      queueingRef.current = false;
      setQueueing(false);
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

  const archiveThread = async (thread: ThreadSummary) => {
    if (!client) return;
    try {
      await client.request(
        archivedThreads ? "thread/unarchive" : "thread/archive",
        { threadId: thread.id },
      );
      setThreads((current) =>
        current.filter((entry) => entry.id !== thread.id),
      );
      if (selectedThread?.id === thread.id) newConversation();
      setNotice({
        tone: "success",
        text: archivedThreads
          ? "Conversation restored."
          : "Conversation archived.",
      });
    } catch (error) {
      setNotice({
        tone: "error",
        text: `Could not update conversation: ${shortError(error)}`,
      });
    }
  };

  const saveRename = async (threadId: string) => {
    if (!client) return;
    const name = renameValue.trim();
    if (!name) return;
    try {
      await client.request("thread/name/set", { threadId, name });
      setThreads((current) =>
        current.map((entry) =>
          entry.id === threadId ? { ...entry, name } : entry,
        ),
      );
      if (selectedThread?.id === threadId)
        setSelectedThread((current) =>
          current ? { ...current, name } : current,
        );
      setRenameId(null);
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
          id: crypto.randomUUID(),
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

  const replyApproval = (result: unknown) => {
    if (!approvalPrompt || !client) return;
    client.respond(approvalPrompt.id, result);
    setApprovalQueue((current) =>
      current.filter((prompt) => prompt.id !== approvalPrompt.id),
    );
    setQuestionAnswers({});
  };

  const rejectUnknownRequest = () => {
    if (!approvalPrompt || !client) return;
    const error: RpcError = {
      code: -32601,
      message: "This web client declined an unsupported server request.",
    };
    client.reject(approvalPrompt.id, error);
    setApprovalQueue((current) =>
      current.filter((prompt) => prompt.id !== approvalPrompt.id),
    );
  };

  useEffect(() => {
    const view = timelineRef.current;
    if (!view) return;
    if (scrollWasNearBottom.current) view.scrollTop = view.scrollHeight;
  }, [items]);

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
      />
    );
  }

  const selectedTitle = selectedThread
    ? titleFor(selectedThread)
    : "New conversation";
  const currentConnection = status.daemon.available ? connection : "offline";
  const hasComposerContent = Boolean(composer.trim() || uploads.length);
  const hasActiveTurn = turnActive || Boolean(activeTurnId);
  const canCompose =
    connection === "online" &&
    !sending &&
    !queueing &&
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
    Boolean(selectedThread && turnActive && activeTurnId);

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div
        className={`mobile-scrim ${mobileSidebarOpen ? "visible" : ""}`}
        onClick={() => setMobileSidebarOpen(false)}
      />
      <aside
        className={`sidebar ${mobileSidebarOpen ? "mobile-open" : ""}`}
        aria-label="Conversation history"
      >
        <div className="sidebar-top">
          <a
            className="brand-lockup"
            href="#home"
            onClick={(event) => event.preventDefault()}
          >
            <span className="brand-mark">
              <Code2 size={17} strokeWidth={2.2} />
            </span>
            <span className="brand-name">
              Codex <span>Desk</span>
            </span>
          </a>
          <button
            className="icon-button sidebar-hide"
            aria-label="Collapse sidebar"
            onClick={() => setSidebarCollapsed(true)}
          >
            <PanelLeftClose size={17} />
          </button>
          <button
            className="icon-button mobile-close"
            aria-label="Close history"
            onClick={() => setMobileSidebarOpen(false)}
          >
            <X size={18} />
          </button>
        </div>

        <button className="new-chat-button" onClick={() => newConversation()}>
          <Plus size={16} strokeWidth={2.2} />
          <span>New conversation</span>
          <kbd>⌘ K</kbd>
        </button>

        <div className="history-controls">
          <button
            className={`history-tab ${!archivedThreads ? "active" : ""}`}
            onClick={() => {
              setArchivedThreads(false);
              setThreadCursor(null);
              if (client) void refreshThreads(client, false, false);
            }}
          >
            Recent
          </button>
          <button
            className={`history-tab ${archivedThreads ? "active" : ""}`}
            onClick={() => {
              setArchivedThreads(true);
              setThreadCursor(null);
              if (client) void refreshThreads(client, true, false);
            }}
          >
            Archived
          </button>
        </div>

        <label className="search-box">
          <span className="sr-only">Search conversations</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4 4" />
          </svg>
          <input
            value={threadSearch}
            onChange={(event) => setThreadSearch(event.target.value)}
            placeholder="Find a conversation"
          />
        </label>

        <div className="thread-list">
          {filteredThreads.length === 0 ? (
            <div className="thread-list-empty">
              {threadSearch
                ? "No matching conversations"
                : archivedThreads
                  ? "No archived conversations"
                  : "Your recent work will appear here"}
            </div>
          ) : (
            filteredThreads.map((thread) => (
              <div
                key={thread.id}
                className={`thread-row ${selectedThread?.id === thread.id ? "selected" : ""}`}
              >
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
                      onClick={() => chooseThread(thread)}
                    >
                      <span className="thread-name">{titleFor(thread)}</span>
                      <span className="thread-preview">
                        {thread.preview || thread.cwd}
                      </span>
                      <span className="thread-meta">
                        <span>
                          {archivedThreads
                            ? formatRelativeTime(thread.updatedAt)
                            : thread.recencyAt === null
                              ? "—"
                              : formatRelativeTime(thread.recencyAt)}
                        </span>
                        <span>
                          {thread.cwd.split("/").filter(Boolean).at(-1) ||
                            thread.cwd}
                        </span>
                      </span>
                    </button>
                    <div className="thread-actions">
                      <button
                        className="thread-action"
                        aria-label={`Rename ${titleFor(thread)}`}
                        title="Rename"
                        onClick={() => {
                          setRenameId(thread.id);
                          setRenameValue(
                            thread.name ?? thread.preview.split("\n")[0] ?? "",
                          );
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        className="thread-action"
                        aria-label={`${archivedThreads ? "Restore" : "Archive"} ${titleFor(thread)}`}
                        title={archivedThreads ? "Restore" : "Archive"}
                        onClick={() => void archiveThread(thread)}
                      >
                        <Archive size={14} />
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))
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
          <div className={`daemon-state ${currentConnection}`}>
            <span className="status-dot" />
            <span>{statusLabel(currentConnection)}</span>
          </div>
          <button
            className="profile-button"
            onClick={() => void signOut()}
            title="Sign out"
          >
            <span className="profile-avatar">C</span>
            <span className="profile-copy">
              <strong>Local daemon</strong>
              <small>Sign out</small>
            </span>
            <MoreHorizontal size={17} />
          </button>
        </div>
      </aside>

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
                <span>Back to {threadTrail.at(-1)?.title}</span>
              </button>
            ) : null}
            <span className="desktop-title">{selectedTitle}</span>
            <ChevronDown size={14} />
          </div>
          <div className="topbar-right">
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
            <span className={`connection-pill ${currentConnection}`}>
              <span className="status-dot" />
              {statusLabel(currentConnection)}
            </span>
            <button
              className="icon-button topbar-help"
              aria-label="Connection details"
              title={
                connectionMessage || status.daemon.endpoint || "Codex daemon"
              }
              onClick={() =>
                setNotice({
                  tone: connection === "online" ? "info" : "error",
                  text:
                    connectionMessage ||
                    status.daemon.error ||
                    status.daemon.endpoint ||
                    "Connected to your local Codex daemon.",
                })
              }
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>

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
          {!selectedThread && items.length === 0 ? (
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
              onChange={(event) => {
                setComposer(event.target.value);
                event.currentTarget.style.height = "auto";
                event.currentTarget.style.height = `${event.currentTarget.scrollHeight}px`;
              }}
              onKeyDown={(event) => {
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
              readOnly={sending || queueing}
              aria-busy={sending || queueing}
            />
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
                  className={`composer-tool ${showSettings ? "active" : ""}`}
                  title="Model and permission options"
                  aria-expanded={showSettings}
                  disabled={
                    sending ||
                    queueing ||
                    selectedThread?.canAcceptDirectInput === false
                  }
                  onClick={() => setShowSettings((value) => !value)}
                >
                  <Shield size={16} />
                  <span className="settings-label">Options</span>
                  <ChevronDown size={13} />
                </button>
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
                          aria-disabled={sending || queueing}
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
                          aria-disabled={sending || queueing}
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
                    {sending ? (
                      <LoaderCircle className="spin" size={17} />
                    ) : (
                      <ArrowUp size={18} strokeWidth={2.3} />
                    )}
                  </button>
                )}
              </div>
            </div>
            {showSettings ? (
              <div className="settings-panel">
                <div className="settings-panel-heading">
                  <div>
                    <strong>Run settings</strong>
                    <span>Applied to the next turn.</span>
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label="Close run settings"
                    onClick={() => setShowSettings(false)}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="settings-grid">
                  <label>
                    <span>Model</span>
                    <select
                      value={model}
                      onChange={(event) => selectModel(event.target.value)}
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
                      onChange={(event) => setSandboxMode(event.target.value)}
                    >
                      <option value="">Keep current sandbox</option>
                      <option value="read-only">Read only · network off</option>
                      <option value="workspace-write">Workspace write</option>
                      <option value="danger-full-access">Full access</option>
                    </select>
                  </label>
                  {!selectedThread ? (
                    <label className="cwd-setting">
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
                        Daemon permissions apply unless you choose an override.
                      </small>
                    </label>
                  ) : (
                    <div className="current-policy">
                      <span>Current daemon policy</span>
                      <strong>
                        {describeApproval(threadDetails?.approvalPolicy)} ·{" "}
                        {describeSandbox(threadDetails?.sandbox)}
                      </strong>
                      {threadDetails?.activePermissionProfile?.id ? (
                        <small>
                          Profile: {threadDetails.activePermissionProfile.id}
                        </small>
                      ) : (
                        <small>New choices apply to your next turn.</small>
                      )}
                    </div>
                  )}
                </div>
              </div>
            ) : null}
          </form>
        </div>
      </main>

      {approvalPrompt ? (
        <ApprovalDialog
          prompt={approvalPrompt}
          unknown={unknownRequest}
          answers={questionAnswers}
          setAnswers={setQuestionAnswers}
          onReply={replyApproval}
          onRejectUnknown={rejectUnknownRequest}
        />
      ) : null}
    </div>
  );
}

function LoginScreen({
  token,
  setToken,
  busy,
  error,
  onSubmit,
}: {
  token: string;
  setToken: (value: string) => void;
  busy: boolean;
  error: string;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="login-page">
      <div className="login-ornament ornament-one" />
      <div className="login-ornament ornament-two" />
      <div className="login-card">
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
          {entries.length} {entries.length === 1 ? "activity" : "activities"}
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
  if (item.type === "commandExecution") return "Command";
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
  if (item.type === "subAgentActivity") return "Subagent activity";
  return humanizeItemType(item.type);
}

function TimelineCard({
  entry,
  onOpenThread,
}: {
  entry: TimelineItem;
  onOpenThread: (threadId: string, parentThreadId?: string) => void;
}) {
  const item = entry.item;
  if (item.type === "userMessage") {
    const content = Array.isArray(item.content)
      ? (item.content as Array<Record<string, unknown>>)
      : [];
    return (
      <article className="message-row user-row">
        <div className="user-message-bubble">
          {content.map((part, index) => (
            <UserInputPart key={index} part={part} />
          ))}
        </div>
      </article>
    );
  }
  if (item.type === "agentMessage") {
    const text = asString(item.text);
    if (!text.trim() && item.delivery !== "failed") return null;
    return (
      <article className="message-row assistant-row">
        <div className="assistant-mark">
          <Code2 size={15} />
        </div>
        <div className="assistant-content">
          {entry.streaming ? (
            <div className="assistant-byline">
              <span className="live-label">
                <i /> Writing
              </span>
            </div>
          ) : null}
          <MarkdownContent text={text} />
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
    const output = asString(item.aggregatedOutput);
    const commandLines = command.split(/\r\n|\r|\n/);
    const commandNeedsExpansion =
      command.length > 180 ||
      commandLines.length > 3 ||
      commandLines.some((line) => line.length > 44);
    const outputLines = output.split(/\r\n|\r|\n/);
    if (/(?:\r\n|\r|\n)$/.test(output)) outputLines.pop();
    const previewLines = outputLines.slice(0, 3);
    const remainingLines = outputLines.slice(3);
    const status = activityStatus(
      item.status ?? (entry.streaming ? "inProgress" : undefined),
    );
    return (
      <div className="activity-card command-activity">
        <div className="command-activity-heading">
          <span className="activity-icon command">
            <Terminal size={14} />
          </span>
          <span className="activity-title">
            {command.trim()
              ? entry.streaming
                ? "Running command"
                : "Command"
              : entry.streaming
                ? "Running command"
                : "Command details unavailable"}
          </span>
          <span className={`activity-status ${status.className}`}>
            {status.label}
          </span>
        </div>
        {command.trim() ? (
          <div className="command-activity-body">
            <pre className="command-preview">
              <code>{command}</code>
            </pre>
            {commandNeedsExpansion ? (
              <details className="command-full">
                <summary>Show full command</summary>
                <pre>
                  <code>{command}</code>
                </pre>
              </details>
            ) : null}
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
  if (part.type === "localImage")
    return (
      <span className="unsupported-attachment">
        Image · {asString(part.path).split("/").at(-1)}
      </span>
    );
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
                ? "Viewed image"
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
      <span className="activity-icon tool">
        <Command size={14} />
      </span>
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
                  <span>Agent {threadId.slice(0, 8)}</span>
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
    started: "Started",
    interacted: "Updated",
    interrupted: "Interrupted",
    completed: "Completed",
  };
  const path = asString(item.agentPath);
  const pathLabel = path.split("/").filter(Boolean).at(-1) || "Agent";
  const threadId = asString(item.agentThreadId);
  const status = activityStatus(kind);

  return (
    <div className="activity-card activity-progress subagent-activity">
      <span className="activity-icon tool">
        <Command size={14} />
      </span>
      <span className="activity-title">
        {pathLabel} · {kindLabels[kind] ?? "Activity"}
      </span>
      {item.model ? (
        <span className="activity-context">{asString(item.model)}</span>
      ) : null}
      <span className={`activity-status ${status.className}`}>
        {status.label}
      </span>
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
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
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
                <h3>{asString(question.header, "Question")}</h3>
                <p>{asString(question.question)}</p>
                {Array.isArray(question.options) && question.options.length ? (
                  <div className="question-options">
                    {(question.options as Array<Record<string, unknown>>).map(
                      (option) => {
                        const label = asString(option.label);
                        const selected = (
                          answers[asString(question.id)] ?? []
                        ).includes(label);
                        return (
                          <button
                            key={label}
                            className={`question-option ${selected ? "selected" : ""}`}
                            onClick={() =>
                              setAnswers({
                                ...answers,
                                [asString(question.id)]: selected
                                  ? (
                                      answers[asString(question.id)] ?? []
                                    ).filter((entry) => entry !== label)
                                  : [
                                      ...(answers[asString(question.id)] ?? []),
                                      label,
                                    ],
                              })
                            }
                          >
                            <span className="option-check">
                              {selected ? <Check size={13} /> : null}
                            </span>
                            <span>
                              <strong>{label}</strong>
                              <small>{asString(option.description)}</small>
                            </span>
                          </button>
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

function formatRelativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
  return new Date(timestamp * 1000).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
