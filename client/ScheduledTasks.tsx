import {
  Archive,
  ArrowUpRight,
  Clock3,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import type {
  ModelOption,
  ScheduledTask,
  ScheduledTaskMode,
  ScheduledTaskSchedule,
  ScheduledTaskWeekday,
  ThreadSummary,
} from "./types";

type Props = {
  currentThread: ThreadSummary | null;
  projectCwd: string;
  models: ModelOption[];
  onOpenThread: (threadId: string) => void;
};

type Draft = {
  name: string;
  prompt: string;
  mode: ScheduledTaskMode;
  scheduleType: ScheduledTaskSchedule["type"];
  interval: number;
  intervalUnit: "minutes" | "hours" | "days";
  time: string;
  weekdays: ScheduledTaskWeekday[];
  timezone: string;
  cwd: string;
  model: string;
  reasoningEffort: string;
};

type Dialog = "library" | "detail" | "editor" | null;

const allWeekdays: Array<{ id: ScheduledTaskWeekday; label: string }> = [
  { id: "MO", label: "Mon" },
  { id: "TU", label: "Tue" },
  { id: "WE", label: "Wed" },
  { id: "TH", label: "Thu" },
  { id: "FR", label: "Fri" },
  { id: "SA", label: "Sat" },
  { id: "SU", label: "Sun" },
];

const emptyDraft = (props: Props): Draft => ({
  name: "",
  prompt: "",
  mode: props.currentThread ? "sameChat" : "newChat",
  scheduleType: "daily",
  interval: 1,
  intervalUnit: "hours",
  time: "09:00",
  weekdays: ["MO", "TU", "WE", "TH", "FR"],
  timezone: "Asia/Singapore",
  cwd: props.projectCwd,
  model: "",
  reasoningEffort: "",
});

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : "Scheduled task request failed";
    throw new Error(message);
  }
  return body as T;
}

function repeatLabel(task: ScheduledTask): string {
  if (task.schedule.type === "interval") {
    const minutes = task.schedule.minutes;
    if (minutes % 1440 === 0) return `Every ${minutes / 1440} days`;
    if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
    return `Every ${minutes} minutes`;
  }
  if (task.schedule.type === "daily") return `Daily · ${task.schedule.time}`;
  const days = task.schedule.weekdays
    .map((id) => allWeekdays.find((day) => day.id === id)?.label)
    .filter(Boolean)
    .join(", ");
  return `${days} · ${task.schedule.time}`;
}

function formatTime(timestamp: number | null, timezone: string): string {
  if (timestamp === null) return "Not scheduled";
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(timestamp));
  } catch {
    return new Date(timestamp).toLocaleString();
  }
}

function draftForTask(task: ScheduledTask): Draft {
  const intervalMinutes =
    task.schedule.type === "interval" ? task.schedule.minutes : 60;
  const intervalUnit =
    intervalMinutes % 1440 === 0
      ? "days"
      : intervalMinutes % 60 === 0
        ? "hours"
        : "minutes";
  const interval =
    intervalUnit === "days"
      ? intervalMinutes / 1440
      : intervalUnit === "hours"
        ? intervalMinutes / 60
        : intervalMinutes;
  return {
    name: task.name,
    prompt: task.prompt,
    mode: task.mode,
    scheduleType: task.schedule.type,
    interval,
    intervalUnit,
    time: task.schedule.type === "interval" ? "09:00" : task.schedule.time,
    weekdays:
      task.schedule.type === "weekly"
        ? task.schedule.weekdays
        : ["MO", "TU", "WE", "TH", "FR"],
    timezone: task.timezone,
    cwd: task.cwd ?? "",
    model: task.model ?? "",
    reasoningEffort: task.reasoningEffort ?? "",
  };
}

export default function ScheduledTasks(props: Props) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(props));
  const [showArchived, setShowArchived] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;
  const listedTasks = useMemo(() => {
    const filtered = tasks.filter((task) =>
      showArchived ? task.status === "archived" : task.status !== "archived",
    );
    return filtered.sort((a, b) => {
      const aTime = a.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.nextRunAt ?? Number.MAX_SAFE_INTEGER;
      return aTime - bTime || a.createdAt - b.createdAt;
    });
  }, [showArchived, tasks]);
  const visibleTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.status !== "archived")
        .sort(
          (a, b) =>
            (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) -
              (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) ||
            a.createdAt - b.createdAt,
        )
        .slice(0, 4),
    [tasks],
  );
  const selectedModel = props.models.find(
    (model) => model.model === draft.model,
  );
  const availableEfforts = selectedModel?.supportedReasoningEfforts ?? [];

  async function refreshTasks(showSpinner = false): Promise<void> {
    if (showSpinner) setLoading(true);
    try {
      const result = await api<ScheduledTask[]>(
        "/api/scheduled-tasks?includeArchived=true",
      );
      setTasks(result);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not load scheduled tasks",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refreshTasks(true);
    const timer = window.setInterval(() => void refreshTasks(), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  function startCreate(): void {
    setSelectedTaskId(null);
    setEditingTaskId(null);
    setDraft(emptyDraft(props));
    setError("");
    setDialog("editor");
  }

  function startEdit(task: ScheduledTask): void {
    setSelectedTaskId(task.id);
    setEditingTaskId(task.id);
    setDraft(draftForTask(task));
    setError("");
    setDialog("editor");
  }

  async function changeTask(
    task: ScheduledTask,
    action: string,
  ): Promise<void> {
    setSaving(true);
    setOpenMenuId(null);
    setError("");
    try {
      await api(
        `/api/scheduled-tasks/${encodeURIComponent(task.id)}/${action}`,
        {
          method: "POST",
          body: "{}",
        },
      );
      await refreshTasks();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Task action failed");
    } finally {
      setSaving(false);
    }
  }

  async function saveTask(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSaving(true);
    setError("");
    const schedule: ScheduledTaskSchedule =
      draft.scheduleType === "interval"
        ? {
            type: "interval",
            minutes:
              draft.intervalUnit === "days"
                ? draft.interval * 1440
                : draft.intervalUnit === "hours"
                  ? draft.interval * 60
                  : draft.interval,
          }
        : draft.scheduleType === "daily"
          ? { type: "daily", time: draft.time }
          : { type: "weekly", time: draft.time, weekdays: draft.weekdays };
    const payload = {
      name: draft.name,
      prompt: draft.prompt,
      mode: draft.mode,
      threadId:
        draft.mode === "sameChat"
          ? ((editingTaskId && selectedTask?.mode === "sameChat"
              ? selectedTask.sourceThreadId
              : props.currentThread?.id) ?? selectedTask?.sourceThreadId)
          : selectedTask?.sourceThreadId,
      cwd: draft.cwd,
      timezone: draft.timezone,
      schedule,
      model: draft.model || null,
      reasoningEffort: draft.reasoningEffort || null,
    };
    try {
      const task = await api<ScheduledTask>(
        editingTaskId
          ? `/api/scheduled-tasks/${encodeURIComponent(editingTaskId)}`
          : "/api/scheduled-tasks",
        {
          method: editingTaskId ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
      await refreshTasks();
      setSelectedTaskId(task.id);
      setEditingTaskId(null);
      setDialog("detail");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not save scheduled task",
      );
    } finally {
      setSaving(false);
    }
  }

  function openDetails(task: ScheduledTask): void {
    setSelectedTaskId(task.id);
    setOpenMenuId(null);
    setError("");
    setDialog("detail");
  }

  function openThread(threadId: string): void {
    setDialog(null);
    props.onOpenThread(threadId);
  }

  function toggleWeekday(day: ScheduledTaskWeekday): void {
    setDraft((current) => ({
      ...current,
      weekdays: current.weekdays.includes(day)
        ? current.weekdays.filter((value) => value !== day)
        : [...current.weekdays, day],
    }));
  }

  const modal = dialog
    ? createPortal(
        <div
          className="scheduled-modal-scrim"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !saving)
              setDialog(null);
          }}
        >
          {dialog === "editor" ? (
            <form
              className="scheduled-modal"
              onSubmit={(event) => void saveTask(event)}
            >
              <header className="scheduled-modal-header">
                <div>
                  <p className="scheduled-eyebrow">Scheduled</p>
                  <h2>{editingTaskId ? "Edit task" : "Schedule a task"}</h2>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close task editor"
                  onClick={() => setDialog(null)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="scheduled-modal-content">
                <label className="scheduled-field">
                  <span>Task name</span>
                  <input
                    required
                    maxLength={120}
                    value={draft.name}
                    onChange={(event) =>
                      setDraft({ ...draft, name: event.target.value })
                    }
                    placeholder="Daily project check-in"
                  />
                </label>
                <label className="scheduled-field">
                  <span>What should Codex do?</span>
                  <textarea
                    required
                    maxLength={12000}
                    rows={5}
                    value={draft.prompt}
                    onChange={(event) =>
                      setDraft({ ...draft, prompt: event.target.value })
                    }
                    placeholder="Describe the work to run on each scheduled check."
                  />
                </label>
                <section
                  className="scheduled-settings-group"
                  aria-label="Repeat settings"
                >
                  <div className="scheduled-settings-row">
                    <label htmlFor="task-repeat">Repeat</label>
                    <select
                      id="task-repeat"
                      value={draft.scheduleType}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          scheduleType: event.target
                            .value as Draft["scheduleType"],
                        })
                      }
                    >
                      <option value="interval">At an interval</option>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                    </select>
                    {draft.scheduleType === "interval" ? (
                      <div className="scheduled-interval-controls">
                        <input
                          aria-label="Interval amount"
                          type="number"
                          min={1}
                          max={
                            draft.intervalUnit === "days"
                              ? 7
                              : draft.intervalUnit === "hours"
                                ? 168
                                : 10080
                          }
                          value={draft.interval}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              interval: Number(event.target.value),
                            })
                          }
                        />
                        <select
                          aria-label="Interval unit"
                          value={draft.intervalUnit}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              intervalUnit: event.target
                                .value as Draft["intervalUnit"],
                            })
                          }
                        >
                          <option value="minutes">minutes</option>
                          <option value="hours">hours</option>
                          <option value="days">days</option>
                        </select>
                      </div>
                    ) : null}
                  </div>
                  {draft.scheduleType !== "interval" ? (
                    <div className="scheduled-settings-row">
                      <label htmlFor="task-time">Time</label>
                      <input
                        id="task-time"
                        type="time"
                        required
                        value={draft.time}
                        onChange={(event) =>
                          setDraft({ ...draft, time: event.target.value })
                        }
                      />
                    </div>
                  ) : null}
                  {draft.scheduleType === "weekly" ? (
                    <div className="scheduled-settings-row scheduled-weekdays-row">
                      <span>On days</span>
                      <div className="scheduled-weekdays">
                        {allWeekdays.map((day) => (
                          <button
                            type="button"
                            key={day.id}
                            className={
                              draft.weekdays.includes(day.id) ? "selected" : ""
                            }
                            aria-pressed={draft.weekdays.includes(day.id)}
                            onClick={() => toggleWeekday(day.id)}
                          >
                            {day.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </section>
                <label className="scheduled-switch-row">
                  <span>
                    <strong>Start each run in a new chat</strong>
                    <small>
                      {draft.mode === "newChat"
                        ? "Every run gets its own conversation."
                        : "Runs continue the selected conversation and its context."}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={draft.mode === "newChat"}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        mode: event.target.checked ? "newChat" : "sameChat",
                      })
                    }
                  />
                </label>
                <details className="scheduled-advanced">
                  <summary>Advanced</summary>
                  <div className="scheduled-advanced-grid">
                    {draft.mode === "newChat" ? (
                      <label className="scheduled-field">
                        <span>Project directory</span>
                        <input
                          required
                          value={draft.cwd}
                          onChange={(event) =>
                            setDraft({ ...draft, cwd: event.target.value })
                          }
                          placeholder="/home/ubuntu/homelab"
                          autoCapitalize="off"
                          autoCorrect="off"
                          spellCheck={false}
                        />
                      </label>
                    ) : (
                      <div className="scheduled-context-note">
                        {props.currentThread?.id ||
                        selectedTask?.sourceThreadId ? (
                          <span>
                            Continues the selected chat ·{" "}
                            {props.currentThread?.cwd || selectedTask?.cwd}
                          </span>
                        ) : (
                          <span>
                            Select a conversation before creating a same-chat
                            task.
                          </span>
                        )}
                      </div>
                    )}
                    <label className="scheduled-field">
                      <span>Timezone</span>
                      <input
                        required
                        value={draft.timezone}
                        onChange={(event) =>
                          setDraft({ ...draft, timezone: event.target.value })
                        }
                        placeholder="Asia/Singapore"
                        autoCapitalize="off"
                        autoCorrect="off"
                        spellCheck={false}
                      />
                    </label>
                    <label className="scheduled-field">
                      <span>Model</span>
                      <select
                        value={draft.model}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            model: event.target.value,
                            reasoningEffort: "",
                          })
                        }
                      >
                        <option value="">Daemon default</option>
                        {props.models.map((model) => (
                          <option key={model.id} value={model.model}>
                            {model.displayName || model.model}
                          </option>
                        ))}
                        {draft.model &&
                        !props.models.some(
                          (entry) => entry.model === draft.model,
                        ) ? (
                          <option value={draft.model}>{draft.model}</option>
                        ) : null}
                      </select>
                    </label>
                    <label className="scheduled-field">
                      <span>Reasoning effort</span>
                      <select
                        value={draft.reasoningEffort}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            reasoningEffort: event.target.value,
                          })
                        }
                      >
                        <option value="">Daemon default</option>
                        {availableEfforts.map((effort) => (
                          <option
                            key={effort.reasoningEffort}
                            value={effort.reasoningEffort}
                          >
                            {effort.reasoningEffort[0]?.toUpperCase()}
                            {effort.reasoningEffort.slice(1)}
                          </option>
                        ))}
                        {draft.reasoningEffort &&
                        !availableEfforts.some(
                          (effort) =>
                            effort.reasoningEffort === draft.reasoningEffort,
                        ) ? (
                          <option value={draft.reasoningEffort}>
                            {draft.reasoningEffort}
                          </option>
                        ) : null}
                      </select>
                    </label>
                    <p className="scheduled-permission-note">
                      Scheduled runs cannot approve actions or answer follow-up
                      questions. Those requests are declined, the task pauses,
                      and the run is recorded in its history.
                    </p>
                  </div>
                </details>
                {error ? <p className="scheduled-error">{error}</p> : null}
              </div>
              <footer className="scheduled-modal-footer">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="primary-action"
                  disabled={
                    saving ||
                    (draft.mode === "sameChat" &&
                      !props.currentThread?.id &&
                      !selectedTask?.sourceThreadId)
                  }
                >
                  {saving
                    ? "Saving…"
                    : editingTaskId
                      ? "Save task"
                      : "Create task"}
                </button>
              </footer>
            </form>
          ) : dialog === "detail" && selectedTask ? (
            <section className="scheduled-modal">
              <header className="scheduled-modal-header">
                <div>
                  <p className="scheduled-eyebrow">
                    {selectedTask.status === "archived"
                      ? "Archived task"
                      : "Scheduled task"}
                  </p>
                  <h2>{selectedTask.name}</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close task details"
                  onClick={() => setDialog(null)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="scheduled-modal-content scheduled-detail-content">
                <p className="scheduled-detail-prompt">{selectedTask.prompt}</p>
                <div className="scheduled-detail-grid">
                  <span>Repeat</span>
                  <strong>{repeatLabel(selectedTask)}</strong>
                  <span>Timezone</span>
                  <strong>{selectedTask.timezone}</strong>
                  <span>Next run</span>
                  <strong>
                    {formatTime(selectedTask.nextRunAt, selectedTask.timezone)}
                  </strong>
                  <span>Destination</span>
                  <strong>
                    {selectedTask.mode === "sameChat"
                      ? "Same chat"
                      : "New chat each run"}
                  </strong>
                  {selectedTask.cwd ? (
                    <>
                      <span>Project</span>
                      <strong className="scheduled-path">
                        {selectedTask.cwd}
                      </strong>
                    </>
                  ) : null}
                  <span>Status</span>
                  <strong className={`scheduled-status ${selectedTask.status}`}>
                    {selectedTask.status}
                    {selectedTask.pauseReason
                      ? ` · ${selectedTask.pauseReason}`
                      : ""}
                  </strong>
                </div>
                {selectedTask.sourceThreadId ? (
                  <button
                    type="button"
                    className="scheduled-chat-link"
                    onClick={() => openThread(selectedTask.sourceThreadId!)}
                  >
                    <ArrowUpRight size={15} />
                    Open associated chat
                  </button>
                ) : null}
                <div className="scheduled-history-heading">
                  <h3>Run history</h3>
                  <span>
                    {selectedTask.runs.length}{" "}
                    {selectedTask.runs.length === 1 ? "run" : "runs"}
                  </span>
                </div>
                {selectedTask.runs.length ? (
                  <ol className="scheduled-run-list">
                    {[...selectedTask.runs].reverse().map((run) => (
                      <li key={run.id} className="scheduled-run-row">
                        <div className="scheduled-run-heading">
                          <time
                            dateTime={new Date(run.scheduledAt).toISOString()}
                          >
                            {formatTime(run.scheduledAt, selectedTask.timezone)}
                          </time>
                          <span
                            className={`scheduled-run-status ${run.status}`}
                          >
                            {run.status}
                          </span>
                        </div>
                        {run.error ? (
                          <p className="scheduled-run-error">{run.error}</p>
                        ) : null}
                        {run.summary ? (
                          <p className="scheduled-run-summary">{run.summary}</p>
                        ) : null}
                        {run.threadId ? (
                          <button
                            type="button"
                            className="scheduled-chat-link"
                            onClick={() => openThread(run.threadId!)}
                          >
                            <ArrowUpRight size={15} />
                            Open this run’s chat
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="scheduled-empty-history">
                    No runs yet. The first result will appear here.
                  </p>
                )}
                {error ? <p className="scheduled-error">{error}</p> : null}
              </div>
              <footer className="scheduled-modal-footer scheduled-detail-footer">
                {selectedTask.status === "archived" ? (
                  <button
                    type="button"
                    className="secondary-action"
                    disabled={saving}
                    onClick={() => void changeTask(selectedTask, "restore")}
                  >
                    Restore
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={saving}
                      onClick={() => void startEdit(selectedTask)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={saving}
                      onClick={() =>
                        void changeTask(
                          selectedTask,
                          selectedTask.status === "paused" ? "resume" : "pause",
                        )
                      }
                    >
                      {selectedTask.status === "paused" ? (
                        <Play size={14} />
                      ) : (
                        <Pause size={14} />
                      )}
                      {selectedTask.status === "paused" ? "Resume" : "Pause"}
                    </button>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={saving}
                      onClick={() => void changeTask(selectedTask, "run-now")}
                    >
                      Run now
                    </button>
                    <button
                      type="button"
                      className="scheduled-archive-action"
                      disabled={saving}
                      onClick={() => void changeTask(selectedTask, "archive")}
                    >
                      <Archive size={14} />
                      Archive
                    </button>
                  </>
                )}
              </footer>
            </section>
          ) : (
            <section className="scheduled-modal scheduled-library">
              <header className="scheduled-modal-header">
                <div>
                  <p className="scheduled-eyebrow">Scheduled</p>
                  <h2>All tasks</h2>
                </div>
                <button
                  className="icon-button"
                  aria-label="Close task list"
                  onClick={() => setDialog(null)}
                >
                  <X size={18} />
                </button>
              </header>
              <div className="scheduled-library-tabs">
                <button
                  className={!showArchived ? "active" : ""}
                  onClick={() => setShowArchived(false)}
                >
                  Active
                </button>
                <button
                  className={showArchived ? "active" : ""}
                  onClick={() => setShowArchived(true)}
                >
                  Archived
                </button>
              </div>
              <div className="scheduled-modal-content">
                {loading ? (
                  <p className="scheduled-empty-history">Loading tasks…</p>
                ) : null}
                {!loading && listedTasks.length === 0 ? (
                  <p className="scheduled-empty-history">
                    {showArchived
                      ? "No archived tasks."
                      : "No scheduled tasks yet."}
                  </p>
                ) : null}
                <div className="scheduled-library-list">
                  {listedTasks.map((task) => (
                    <button
                      key={task.id}
                      className="scheduled-library-row"
                      onClick={() => openDetails(task)}
                    >
                      <span>
                        <strong>{task.name}</strong>
                        <small>
                          {repeatLabel(task)} ·{" "}
                          {formatTime(task.nextRunAt, task.timezone)}
                        </small>
                      </span>
                      <span className={`scheduled-status ${task.status}`}>
                        {task.status}
                      </span>
                    </button>
                  ))}
                </div>
                {error ? <p className="scheduled-error">{error}</p> : null}
              </div>
              <footer className="scheduled-modal-footer">
                <button
                  type="button"
                  className="secondary-action"
                  onClick={() => startCreate()}
                >
                  <Plus size={15} />
                  New task
                </button>
                <button
                  type="button"
                  className="primary-action"
                  onClick={() => setDialog(null)}
                >
                  Done
                </button>
              </footer>
            </section>
          )}
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <section className="scheduled-sidebar" aria-label="Scheduled tasks">
        <header className="scheduled-sidebar-heading">
          <span>
            <Clock3 size={14} />
            Scheduled
          </span>
          <button
            type="button"
            onClick={startCreate}
            aria-label="Create scheduled task"
            title="New task"
          >
            <Plus size={16} />
          </button>
        </header>
        {!visibleTasks.length && !loading ? (
          <p className="scheduled-sidebar-empty">
            Tasks you schedule will appear here.
          </p>
        ) : null}
        {visibleTasks.map((task) => (
          <div key={task.id} className="scheduled-sidebar-row">
            <button
              type="button"
              className="scheduled-sidebar-main"
              onClick={() => openDetails(task)}
            >
              <strong>{task.name}</strong>
              <span>{repeatLabel(task)}</span>
              <small className={`scheduled-status ${task.status}`}>
                {task.status}
              </small>
            </button>
            <div className="scheduled-sidebar-menu-wrap">
              <button
                type="button"
                className="scheduled-sidebar-more"
                aria-label={`Actions for ${task.name}`}
                aria-expanded={openMenuId === task.id}
                onClick={() =>
                  setOpenMenuId(openMenuId === task.id ? null : task.id)
                }
              >
                <MoreHorizontal size={17} />
              </button>
              {openMenuId === task.id ? (
                <div className="scheduled-sidebar-menu" role="menu">
                  <button role="menuitem" onClick={() => startEdit(task)}>
                    <Pencil size={14} />
                    Edit
                  </button>
                  <button
                    role="menuitem"
                    onClick={() =>
                      void changeTask(
                        task,
                        task.status === "paused" ? "resume" : "pause",
                      )
                    }
                  >
                    {task.status === "paused" ? (
                      <Play size={14} />
                    ) : (
                      <Pause size={14} />
                    )}
                    {task.status === "paused" ? "Resume" : "Pause"}
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => void changeTask(task, "run-now")}
                  >
                    <Play size={14} />
                    Run now
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => void changeTask(task, "archive")}
                  >
                    <Archive size={14} />
                    Archive
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ))}
        <button
          type="button"
          className="scheduled-sidebar-all"
          onClick={() => {
            setShowArchived(false);
            setDialog("library");
          }}
        >
          All tasks
          {tasks.filter((task) => task.status === "archived").length
            ? ` · ${tasks.filter((task) => task.status === "archived").length} archived`
            : ""}
        </button>
        {error ? <p className="scheduled-sidebar-error">{error}</p> : null}
      </section>
      {modal}
    </>
  );
}
