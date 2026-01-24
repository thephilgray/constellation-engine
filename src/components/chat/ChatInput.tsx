import React, { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ChatInputProps {
  onSend: (message: string) => void;
  isLoading: boolean;
}

export const ChatInput: React.FC<ChatInputProps> = ({ onSend, isLoading }) => {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const STORAGE_KEY = "constellation_chat_draft";

  // Load draft on mount
  useEffect(() => {
    const savedDraft = localStorage.getItem(STORAGE_KEY);
    if (savedDraft) {
      setInput(savedDraft);
    }
  }, []);

  // Auto-resize and save draft
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, input);

    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [input]);

  const handleSend = () => {
    if (input.trim() && !isLoading) {
      onSend(input);
      setInput("");
      localStorage.removeItem(STORAGE_KEY);
      // Reset height manually since the useEffect depends on input change, 
      // but sometimes the flush happens before the render? 
      // Actually the useEffect will trigger on setInput("") and reset it to scrollHeight (likely small).
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="p-4 border-t flex gap-2 items-end">
      <textarea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message..."
        disabled={isLoading}
        rows={1}
        className={cn(
          "flex-1 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-sm transition-[color,box-shadow] outline-none",
          "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
          "dark:bg-input/30",
          "min-h-[38px] max-h-[200px] resize-none overflow-y-auto" 
        )}
      />
      <Button 
        onClick={handleSend} 
        disabled={isLoading || !input.trim()}
        className="mb-[1px]" 
      >
        {isLoading ? "..." : "Send"}
      </Button>
    </div>
  );
};