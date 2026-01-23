import React, { useEffect, useRef } from "react";
import { Message, type MessageProps } from "./Message";

interface MessageListProps {
  messages: MessageProps[];
}

export const MessageList: React.FC<MessageListProps> = ({ messages }) => {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {messages.map((msg, index) => (
        <Message key={index} role={msg.role} content={msg.content} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
};
