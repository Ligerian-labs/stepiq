import { useState } from "react";

interface ChatInputProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInput({ onSend, disabled, placeholder }: ChatInputProps) {
  const [message, setMessage] = useState("");

  const handleSend = () => {
    if (!message.trim() || disabled) return;
    onSend(message);
    setMessage("");
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder || "Type a message... (⌘+Enter to send)"}
        className="flex-1 rounded-lg border border-[var(--divider)] bg-[var(--bg-inset)] px-4 py-2 text-sm focus:border-[var(--accent)] focus:outline-none disabled:opacity-50"
        disabled={disabled}
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={!message.trim() || disabled}
        className="rounded-lg bg-[var(--accent)] px-6 py-2 text-sm font-semibold text-[var(--bg-primary)] disabled:opacity-50"
      >
        Send
      </button>
    </div>
  );
}
