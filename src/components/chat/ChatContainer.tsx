import React, { useState, useEffect } from "react";
import "@/lib/amplify"; // Ensure Amplify is configured
import { getCurrentUser, fetchAuthSession, signOut } from "aws-amplify/auth";
import { MessageList } from "./MessageList";
import { ChatInput } from "./ChatInput";
import { Login } from "./Login";
import type { MessageProps } from "./Message";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { API_URL } from "@/lib/amplify";

export const ChatContainer: React.FC = () => {
  const [messages, setMessages] = useState<MessageProps[]>([
    { role: "assistant", content: "Hello! I am the Constellation Engine. How can I help you organize your thoughts today?" }
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthChecking, setIsAuthChecking] = useState(true);

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      await getCurrentUser();
      setIsAuthenticated(true);
    } catch (err) {
      setIsAuthenticated(false);
    } finally {
      setIsAuthChecking(false);
    }
  };

  const handleLogout = async () => {
    try {
      await signOut();
      setIsAuthenticated(false);
      setMessages([{ role: "assistant", content: "Hello! I am the Constellation Engine. How can I help you organize your thoughts today?" }]);
    } catch (error) {
      console.error("Error signing out: ", error);
    }
  };

  const handleSend = async (content: string) => {
    // Add user message
    const userMessage: MessageProps = { role: "user", content };
    setMessages((prev) => [...prev, userMessage]);

    // Local Command Handling: /help
    if (content.trim().toLowerCase() === "/help") {
        const helpMessage: MessageProps = {
            role: "assistant",
            content: `**Constellation Engine Help**

Here is how you can use the system:

*   **Save a Note:** Just type your thought, idea, or paste an article. The system detects "saving" intent automatically.
*   **Ask a Question:** Ask anything! The "Incubator" will search your saved knowledge to provide an answer with citations.
*   **Slash Commands:**
    *   \`/dream\`: Trigger a serendipitous connection (The Dreamer).
    *   \`/reflect [timeframe]\`: Generate a review (The Biographer).
    *   \`/fic <idea/scene>\`: Update the Story Bible (The Storyteller).
    *   \`/lyrics <line>\`: Update Song Seeds (The Bard).
    *   \`/read\`: Trigger the Dialectical Librarian.
`
        };
        setTimeout(() => setMessages((prev) => [...prev, helpMessage]), 500);
        return;
    }

    setIsLoading(true);

    try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();

        if (!token) {
            throw new Error("No authentication token found.");
        }

        // Command Routing
        let endpoint = `${API_URL}/ingest`;
        let body: any = { content, type: "IDEA" };
        let isCommand = false;

        const lowerContent = content.trim().toLowerCase();

        if (lowerContent.startsWith("/dream")) {
            endpoint = `${API_URL}/dream`;
            const param = content.substring(6).trim();
            body = param ? { content: param } : {}; 
            isCommand = true;
        } else if (lowerContent.startsWith("/reflect")) {
            endpoint = `${API_URL}/reflect`;
            const param = content.substring(8).trim() || "Today";
            body = { content: param, tag: "JOURNAL", date: new Date().toISOString() };
            isCommand = true;
        } else if (lowerContent.startsWith("/fic")) {
            endpoint = `${API_URL}/fiction`;
            const param = content.substring(4).trim();
            if (!param) throw new Error("Please provide an idea or scene description.");
            body = { content: param, tag: "IDEA" };
            isCommand = true;
        } else if (lowerContent.startsWith("/lyrics")) {
            endpoint = `${API_URL}/lyrics`;
            const param = content.substring(7).trim();
            if (!param) throw new Error("Please provide a lyric line.");
            body = { content: param };
            isCommand = true;
        } else if (lowerContent.startsWith("/read") || lowerContent.startsWith("/recommend")) {
            endpoint = `${API_URL}/read`;
            body = {};
            isCommand = true;
        }

        const response = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || "Failed to process request");
        }

        const data = await response.json();
        
        let responseContent = "";
        let sources = undefined;

        if (isCommand) {
             if (data.spark) {
                 responseContent = `**The Dreamer (Spark):**\n\n${data.spark}`;
             } else if (data.dreamAnalysis) {
                 responseContent = `**The Dreamer (Analysis):**\n\n${data.dreamAnalysis}`;
             } else if (data.analysis) {
                 responseContent = `**The Biographer:**\n\n${data.analysis}`;
             } else if (data.storyBible) {
                 responseContent = `**The Storyteller (Updated Bible):**\n\n${data.storyBible}`;
             } else if (data.songSeeds) {
                 responseContent = `**The Bard (Song Seeds):**\n\n${data.songSeeds}`;
             } else {
                 responseContent = data.message || "Command executed.";
             }
        } else {
             // Ingest / Query logic
            if (data.intent === 'query' && data.answer) {
                 responseContent = data.answer;
                 sources = data.contextSources;
            } else if (data.intent === 'save') {
                 responseContent = `Saved! (ID: ${data.id})`;
            } else {
                 responseContent = data.message || "Operation complete.";
            }
        }
        
        const aiMessage: MessageProps = { 
            role: "assistant", 
            content: responseContent,
            sources: sources
        };
        setMessages((prev) => [...prev, aiMessage]);

    } catch (error: any) {
        console.error(error);
        const errorMessage: MessageProps = {
            role: "assistant",
            content: `Error: ${error.message}`
        };
        setMessages((prev) => [...prev, errorMessage]);
    } finally {
        setIsLoading(false);
    }
  };

  if (isAuthChecking) {
    return <div className="flex h-screen items-center justify-center">Loading...</div>;
  }

  if (!isAuthenticated) {
    return <Login onLoginSuccess={() => setIsAuthenticated(true)} />;
  }

  return (
    <div className="flex justify-center items-center h-screen bg-neutral-100 dark:bg-neutral-900 p-4">
      <Card className="w-full max-w-2xl h-[80vh] flex flex-col shadow-xl relative">
        <div className="p-4 border-b font-semibold text-lg flex justify-between items-center">
          <span>Constellation Chat</span>
          <Button variant="ghost" size="sm" onClick={handleLogout}>Sign Out</Button>
        </div>
        <MessageList messages={messages} isLoading={isLoading} />
        <ChatInput onSend={handleSend} isLoading={isLoading} />
      </Card>
    </div>
  );
};
