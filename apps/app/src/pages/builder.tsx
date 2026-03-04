import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AppShell } from "../components/app-shell";
import { ApiError, type ChatMessage, type ChatSession, apiFetch } from "../lib/api";

type OptimisticMessage = {
  id: string;
  role: "user";
  content: string;
  createdAt: string;
  optimistic: true;
};

export function BuilderPage() {
  const { sessionId } = useParams({ strict: false }) as { sessionId?: string };
  const sessionResetKey = sessionId ?? "__new__";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeAbortControllerRef = useRef<AbortController | null>(null);
  const previousMessageCountRef = useRef(0);
  const previousThinkingRef = useRef(false);

  const [message, setMessage] = useState("");
  const [selectedModel, setSelectedModel] = useState("gpt-5.2");
  const [showSessions, setShowSessions] = useState(true);
  const [chatError, setChatError] = useState<string | null>(null);
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null);
  const [optimisticMessages, setOptimisticMessages] = useState<
    OptimisticMessage[]
  >([]);
  const [cancelHintVisible, setCancelHintVisible] = useState(false);
  const [cancelArmedUntil, setCancelArmedUntil] = useState<number | null>(null);
  const [showScrollTop, setShowScrollTop] = useState(false);

  const modelsQ = useQuery({
    queryKey: ["models"],
    queryFn: () =>
      apiFetch<Array<{ id: string; name: string }>>(
        "/api/models",
        undefined,
        false,
      ),
  });

  const sessionsQ = useQuery({
    queryKey: ["chat-sessions"],
    queryFn: () => apiFetch<ChatSession[]>("/api/chat/sessions"),
  });

  const sessionQ = useQuery({
    queryKey: ["chat-session", sessionId],
    queryFn: () =>
      apiFetch<ChatSession & { messages: ChatMessage[] }>(
        `/api/chat/sessions/${sessionId}`,
      ),
    enabled: Boolean(sessionId),
  });

  useEffect(() => {
    if (sessionQ.data?.modelId) {
      setSelectedModel(sessionQ.data.modelId);
    }
  }, [sessionQ.data?.modelId]);

  useEffect(() => {
    void sessionResetKey;
    setOptimisticMessages([]);
    setActiveRequestId(null);
    setCancelHintVisible(false);
    setCancelArmedUntil(null);
    activeAbortControllerRef.current = null;
  }, [sessionResetKey]);

  useEffect(() => {
    const onScroll = () => {
      setShowScrollTop(window.scrollY > 300);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isThinking = Boolean(activeRequestId);
  const displayedMessages = [
    ...(sessionQ.data?.messages || []),
    ...optimisticMessages,
  ];

  useEffect(() => {
    const hasNewMessage = displayedMessages.length > previousMessageCountRef.current;
    const thinkingStarted = isThinking && !previousThinkingRef.current;
    if (hasNewMessage || thinkingStarted) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    previousMessageCountRef.current = displayedMessages.length;
    previousThinkingRef.current = isThinking;
  }, [displayedMessages.length, isThinking]);

  const cancelInFlight = async () => {
    if (!activeRequestId || !sessionId) return;
    try {
      await apiFetch<{ canceled: boolean }>(
        `/api/chat/sessions/${sessionId}/messages/${activeRequestId}/cancel`,
        { method: "POST" },
      );
    } catch {
      // Best-effort cancel.
    }
    activeAbortControllerRef.current?.abort();
    activeAbortControllerRef.current = null;
    setCancelHintVisible(false);
    setCancelArmedUntil(null);
    setActiveRequestId(null);
    setOptimisticMessages((current) =>
      current.filter((msg) => msg.id !== activeRequestId),
    );
    queryClient.invalidateQueries({ queryKey: ["chat-session", sessionId] });
  };

  const sendMessageMut = useMutation({
    mutationFn: ({
      targetSessionId,
      content,
      requestId,
      signal,
    }: {
      targetSessionId: string;
      content: string;
      requestId: string;
      signal?: AbortSignal;
    }) =>
      apiFetch<{ content: string; pipelineState: unknown; requestId?: string }>(
        `/api/chat/sessions/${targetSessionId}/messages`,
        {
          method: "POST",
          body: JSON.stringify({ content, requestId }),
          signal,
        },
      ),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["chat-session", variables.targetSessionId],
      });
      setChatError(null);
      setOptimisticMessages((current) =>
        current.filter((msg) => msg.id !== variables.requestId),
      );
      setActiveRequestId((current) =>
        current === variables.requestId ? null : current,
      );
      setCancelHintVisible(false);
      setCancelArmedUntil(null);
      activeAbortControllerRef.current = null;
    },
    onError: (error, variables) => {
      setOptimisticMessages((current) =>
        current.filter((msg) => msg.id !== variables.requestId),
      );
      setActiveRequestId((current) =>
        current === variables.requestId ? null : current,
      );
      if (error instanceof Error && error.name === "AbortError") {
        setCancelHintVisible(false);
        setCancelArmedUntil(null);
        return;
      }
      setChatError(
        error instanceof ApiError
          ? error.message
          : "Failed to send message. Please try again.",
      );
    },
  });

  const createSessionMut = useMutation({
    mutationFn: (payload?: { initialMessage?: string; requestId?: string }) =>
      apiFetch<ChatSession>("/api/chat/sessions", {
        method: "POST",
        body: JSON.stringify({ modelId: selectedModel }),
      }),
    onSuccess: (session, payload) => {
      queryClient.invalidateQueries({ queryKey: ["chat-sessions"] });
      setChatError(null);
      navigate({
        to: "/builder/$sessionId",
        params: { sessionId: session.id },
      });
      const initialMessage = payload?.initialMessage?.trim();
      if (initialMessage && payload?.requestId) {
        const controller = new AbortController();
        activeAbortControllerRef.current = controller;
        setActiveRequestId(payload.requestId);
        sendMessageMut.mutate({
          targetSessionId: session.id,
          content: initialMessage,
          requestId: payload.requestId,
          signal: controller.signal,
        });
      }
    },
    onError: (error) => {
      setOptimisticMessages([]);
      setActiveRequestId(null);
      setChatError(
        error instanceof ApiError
          ? error.message
          : "Failed to create chat session. Please try again.",
      );
    },
  });

  const handleSendMessage = () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) return;
    if (isThinking) return;
    const requestId = crypto.randomUUID();
    const newOptimisticMessage: OptimisticMessage = {
      id: requestId,
      role: "user",
      content: trimmedMessage,
      createdAt: new Date().toISOString(),
      optimistic: true,
    };
    setOptimisticMessages((current) => [...current, newOptimisticMessage]);
    setChatError(null);
    setMessage("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    setCancelArmedUntil(null);
    setCancelHintVisible(false);

    if (!sessionId) {
      setActiveRequestId(requestId);
      createSessionMut.mutate({
        initialMessage: trimmedMessage,
        requestId,
      });
      return;
    }
    const controller = new AbortController();
    activeAbortControllerRef.current = controller;
    setActiveRequestId(requestId);
    sendMessageMut.mutate({
      targetSessionId: sessionId,
      content: trimmedMessage,
      requestId,
      signal: controller.signal,
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape" && isThinking) {
      e.preventDefault();
      const now = Date.now();
      if (cancelArmedUntil && now <= cancelArmedUntil) {
        void cancelInFlight();
        return;
      }
      setCancelArmedUntil(now + 2000);
      setCancelHintVisible(true);
      window.setTimeout(() => {
        setCancelHintVisible(false);
        setCancelArmedUntil((value) =>
          value && value <= Date.now() ? null : value,
        );
      }, 2000);
      return;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleScrollTop = () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const actions = (
    <div className="flex items-center gap-3">
      <button
        type="button"
        onClick={() => setShowSessions(!showSessions)}
        className="rounded-lg border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-sm hover:bg-[var(--bg-inset)]"
        aria-label={
          showSessions ? "Hide sessions sidebar" : "Show sessions sidebar"
        }
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {showSessions ? (
            <>
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </>
          ) : (
            <>
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="3" width="7" height="18" rx="1" />
            </>
          )}
        </svg>
      </button>
      <select
        value={selectedModel}
        onChange={(e) => setSelectedModel(e.target.value)}
        className="rounded-lg border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-sm"
      >
        {modelsQ.data?.map((model) => (
          <option key={model.id} value={model.id}>
            {model.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => createSessionMut.mutate(undefined)}
        className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--bg-primary)]"
      >
        + New Chat
      </button>
    </div>
  );

  return (
    <AppShell
      title="Builder"
      subtitle="Create pipelines with natural language"
      actions={actions}
    >
      <div className="flex min-h-[calc(100vh-180px)] gap-6">
        <div
          className={`flex flex-col rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)] transition-all duration-300 ${
            showSessions ? "w-80" : "w-0 overflow-hidden border-0"
          }`}
        >
          <div className="border-b border-[var(--divider)] p-4">
            <h3 className="text-sm font-semibold">Chat Sessions</h3>
          </div>
          <div className="flex-1 overflow-auto p-2">
            {sessionsQ.isLoading ? (
              <p className="p-2 text-xs text-[var(--text-muted)]">Loading...</p>
            ) : (
              sessionsQ.data?.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() =>
                    navigate({
                      to: "/builder/$sessionId",
                      params: { sessionId: session.id },
                    })
                  }
                  className={`w-full rounded-lg p-3 text-left text-sm transition-colors ${
                    sessionId === session.id
                      ? "bg-[var(--bg-inset)]"
                      : "hover:bg-[var(--bg-inset)]"
                  }`}
                >
                  <p className="truncate font-medium">
                    {session.title || "New Chat"}
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {new Date(session.updatedAt).toLocaleDateString()}
                  </p>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col rounded-xl border border-[var(--divider)] bg-[var(--bg-surface)]">
          <div className="p-4">
            {!sessionId ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-sm text-[var(--text-muted)]">
                  Select a chat session or create a new one to get started
                </p>
              </div>
            ) : sessionQ.isLoading ? (
              <p className="text-sm text-[var(--text-muted)]">
                Loading session...
              </p>
            ) : (
              displayedMessages.map((msg: ChatMessage | OptimisticMessage) => (
                <div
                  key={msg.id}
                  className={`mb-4 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-lg px-4 py-3 ${
                      msg.role === "user"
                        ? "bg-[var(--accent)] text-[var(--bg-primary)]"
                        : "bg-[var(--bg-inset)]"
                    }`}
                  >
                    <p className="whitespace-pre-wrap text-sm">{msg.content}</p>
                  </div>
                </div>
              ))
            )}
            {isThinking ? (
              <div className="mb-4 flex justify-start">
                <div className="rounded-lg bg-[var(--bg-inset)] px-4 py-3 text-sm text-[var(--text-muted)]">
                  Thinking...
                </div>
              </div>
            ) : null}
            <div ref={messagesEndRef} />
          </div>

          <div className="border-t border-[var(--divider)] p-4">
            <div className="flex items-end gap-2">
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => {
                  setMessage(e.target.value);
                  e.currentTarget.style.height = "auto";
                  e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder="Describe your pipeline... (Enter = send, Shift+Enter = newline, Esc Esc = cancel)"
                rows={1}
                className="max-h-64 min-h-[40px] flex-1 resize-none overflow-y-auto rounded-lg border border-[var(--divider)] bg-[var(--bg-inset)] px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none"
                disabled={createSessionMut.isPending || sendMessageMut.isPending || isThinking}
              />
              <button
                type="button"
                onClick={handleSendMessage}
                disabled={
                  !message.trim() ||
                  createSessionMut.isPending ||
                  sendMessageMut.isPending ||
                  isThinking
                }
                className="h-10 shrink-0 self-end rounded-lg bg-[var(--accent)] px-6 text-sm font-semibold text-[var(--bg-primary)] disabled:opacity-50"
              >
                {isThinking ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-[var(--bg-primary)] border-t-transparent" />
                    Thinking...
                  </span>
                ) : (
                  "Send"
                )}
              </button>
            </div>
            {cancelHintVisible ? (
              <p className="mt-2 text-xs text-[var(--text-muted)]">
                Press Esc again to cancel
              </p>
            ) : null}
            {chatError ? (
              <p className="mt-2 text-xs text-[#fca5a5]">{chatError}</p>
            ) : null}
          </div>
        </div>
      </div>
      {showScrollTop ? (
        <button
          type="button"
          onClick={handleScrollTop}
          className="fixed bottom-6 right-6 z-20 rounded-full border border-[var(--divider)] bg-[var(--bg-surface)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] shadow-lg hover:bg-[var(--bg-inset)]"
          aria-label="Scroll to top"
        >
          ↑ Top
        </button>
      ) : null}
    </AppShell>
  );
}
