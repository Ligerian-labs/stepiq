import type { ChatMessage as ChatMessageType } from "../../lib/api";

interface ChatMessageProps {
  message: ChatMessageType;
}

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="mb-4 flex justify-center">
        <div className="rounded-lg bg-[var(--bg-inset)] px-4 py-2 text-xs text-[var(--text-muted)]">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className={`mb-4 flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-lg px-4 py-3 ${
          isUser
            ? "bg-[var(--accent)] text-[var(--bg-primary)]"
            : "bg-[var(--bg-inset)]"
        }`}
      >
        <p className="whitespace-pre-wrap text-sm">{message.content}</p>
        <p
          className={`mt-1 text-xs ${
            isUser ? "text-[var(--bg-primary)]/70" : "text-[var(--text-muted)]"
          }`}
        >
          {new Date(message.createdAt).toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
