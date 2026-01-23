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
    setIsLoading(true);

    try {
        const session = await fetchAuthSession();
        const token = session.tokens?.idToken?.toString();

        if (!token) {
            throw new Error("No authentication token found.");
        }

        const response = await fetch(`${API_URL}/ingest`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ content, type: "IDEA" }) // Defaulting to IDEA for now
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.message || "Failed to send message");
        }

        const data = await response.json();
        
        // The ingest endpoint currently returns a success message, but not the synthesized response directly
        // because it updates the Dashboard file.
        // For the chat UI, we might want to display a confirmation or fetch the updated dashboard snippet.
        // For now, let's display a generic success or the data if available.
        
        const aiMessage: MessageProps = { 
            role: "assistant", 
            content: `Saved! (ID: ${data.id})` 
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
        <MessageList messages={messages} />
        <ChatInput onSend={handleSend} isLoading={isLoading} />
      </Card>
    </div>
  );
};
