import React, { useState, useEffect } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_URL } from "@/lib/amplify";
import { BookOpen, Mic2, Moon, Sparkles } from "lucide-react"; // Icons

const DASHBOARDS = [
    { id: "life_log", label: "Life Log", icon: <BookOpen className="w-4 h-4 mr-2" /> },
    { id: "story_bible", label: "Story Bible", icon: <Sparkles className="w-4 h-4 mr-2" /> },
    { id: "song_seeds", label: "Song Seeds", icon: <Mic2 className="w-4 h-4 mr-2" /> },
    { id: "dream_analysis", label: "Dream Journal", icon: <Moon className="w-4 h-4 mr-2" /> },
];

interface DashboardViewerProps {
    onClose: () => void;
}

export const DashboardViewer: React.FC<DashboardViewerProps> = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState("life_log");
    const [content, setContent] = useState<string>("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchDashboard(activeTab);
    }, [activeTab]);

    const fetchDashboard = async (type: string) => {
        setIsLoading(true);
        setError(null);
        try {
            const session = await fetchAuthSession();
            const token = session.tokens?.idToken?.toString();
            if (!token) throw new Error("No auth token");

            const res = await fetch(`${API_URL}/dashboard?type=${type}`, {
                headers: { Authorization: `Bearer ${token}` }
            });

            if (!res.ok) throw new Error("Failed to fetch dashboard");

            const data = await res.json();
            setContent(data.content);
        } catch (err: any) {
            console.error(err);
            setError(err.message || "Could not load dashboard.");
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
            <Card className="w-full max-w-4xl h-[90vh] flex flex-col bg-white dark:bg-neutral-900 shadow-2xl overflow-hidden border-neutral-200 dark:border-neutral-800">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                    <h2 className="text-xl font-bold flex items-center text-neutral-900 dark:text-neutral-100">
                        Constellation Office
                    </h2>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        Close
                    </Button>
                </div>

                {/* Sidebar & Content Layout */}
                <div className="flex flex-1 overflow-hidden">
                    {/* Sidebar / Tabs */}
                    <div className="w-48 md:w-64 border-r border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950 flex flex-col p-2 space-y-1 overflow-y-auto">
                        {DASHBOARDS.map((dash) => (
                            <Button
                                key={dash.id}
                                variant={activeTab === dash.id ? "secondary" : "ghost"}
                                className={`justify-start w-full ${activeTab === dash.id ? "bg-white dark:bg-neutral-800 shadow-sm" : ""}`}
                                onClick={() => setActiveTab(dash.id)}
                            >
                                {dash.icon}
                                {dash.label}
                            </Button>
                        ))}
                    </div>

                    {/* Main Content Area */}
                    <div className="flex-1 overflow-y-auto p-8 bg-white dark:bg-neutral-900 scroll-smooth">
                        {isLoading ? (
                            <div className="flex h-full items-center justify-center text-neutral-500 animate-pulse">
                                Loading archival data...
                            </div>
                        ) : error ? (
                            <div className="flex h-full items-center justify-center text-red-500">
                                {error}
                            </div>
                        ) : (
                            <article className="prose prose-neutral dark:prose-invert max-w-none">
                                <Markdown>{content}</Markdown>
                            </article>
                        )}
                    </div>
                </div>
            </Card>
        </div>
    );
};
