import React from "react";
import { cn } from "@/lib/utils";
import ReactMarkdown from "react-markdown";

export interface MessageProps {
  role: "user" | "assistant";
  content: string;
}

export const Message: React.FC<MessageProps> = ({ role, content }) => {
  return (
    <div
      className={cn(
        "flex w-full mb-4",
        role === "user" ? "justify-end" : "justify-start"
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-lg px-4 py-2 text-sm overflow-x-auto",
          role === "user"
            ? "bg-blue-600 text-white rounded-br-none"
            : "bg-neutral-200 text-neutral-800 rounded-bl-none dark:bg-neutral-800 dark:text-neutral-100"
        )}
      >
        <ReactMarkdown 
          components={{
            p: ({node, ...props}) => <p className="mb-2 last:mb-0" {...props} />,
            ul: ({node, ...props}) => <ul className="list-disc ml-4 mb-2" {...props} />,
            ol: ({node, ...props}) => <ol className="list-decimal ml-4 mb-2" {...props} />,
            li: ({node, ...props}) => <li className="mb-1" {...props} />,
            pre: ({node, ...props}) => <pre className="bg-black/10 dark:bg-white/10 rounded p-2 mb-2 overflow-x-auto" {...props} />,
            code: ({node, ...props}) => <code className="bg-black/10 dark:bg-white/10 rounded px-1 py-0.5 font-mono text-xs" {...props} />
          }}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
};
