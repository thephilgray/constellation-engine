import React, { useEffect, useRef } from "react";
import { Message, type MessageProps } from "./Message";

interface MessageListProps {
  messages: MessageProps[];
  isLoading?: boolean;
}

export const MessageList: React.FC<MessageListProps> = ({ messages, isLoading }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.map((msg, index) => (
        <Message key={index} role={msg.role} content={msg.content} />
      ))}
      {isLoading && (
        <div className="flex justify-start my-2">
            <div className="bg-neutral-200 dark:bg-neutral-800 text-neutral-500 rounded-lg py-2 px-4 text-sm animate-pulse">
                Thinking...
            </div>
        </div>
      )}
      <div ref={bottomRef} />
    </div>
  );
};
