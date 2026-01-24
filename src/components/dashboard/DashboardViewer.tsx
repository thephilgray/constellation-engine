import React, { useState, useEffect } from "react";
import { fetchAuthSession } from "aws-amplify/auth";
import Markdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { API_URL } from "@/lib/amplify";
import { BookOpen, Mic2, Moon, Sparkles, Library, Lightbulb, Menu, X } from "lucide-react"; // Icons

const DASHBOARDS = [
    { id: "life_log", label: "Life Log", icon: <BookOpen className="w-4 h-4 mr-2" /> },
    { id: "idea_garden", label: "Idea Garden", icon: <Lightbulb className="w-4 h-4 mr-2" /> },
    { id: "story_bible", label: "Story Bible", icon: <Sparkles className="w-4 h-4 mr-2" /> },
    { id: "song_seeds", label: "Song Seeds", icon: <Mic2 className="w-4 h-4 mr-2" /> },
    { id: "dream_analysis", label: "Dream Journal", icon: <Moon className="w-4 h-4 mr-2" /> },
    { id: "reading_list", label: "Reading List", icon: <Library className="w-4 h-4 mr-2" /> },
];

interface DashboardViewerProps {
    onClose: () => void;
}

export const DashboardViewer: React.FC<DashboardViewerProps> = ({ onClose }) => {
    const [activeTab, setActiveTab] = useState("life_log");
    const [content, setContent] = useState<string>("");
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

    useEffect(() => {
        fetchDashboard(activeTab);
        // Close mobile menu when tab changes
        setIsMobileMenuOpen(false);
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
            <Card className="w-full max-w-6xl h-[90vh] flex flex-col bg-white dark:bg-neutral-900 shadow-2xl overflow-hidden border-neutral-200 dark:border-neutral-800">
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
                    <div className="flex items-center gap-2">
                        <Button 
                            variant="ghost" 
                            size="icon" 
                            className="md:hidden"
                            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                        >
                            {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                        </Button>
                        <h2 className="text-xl font-bold flex items-center text-neutral-900 dark:text-neutral-100">
                            Constellation Office
                        </h2>
                    </div>
                    <Button variant="ghost" size="sm" onClick={onClose}>
                        Close
                    </Button>
                </div>

                {/* Sidebar & Content Layout */}
                <div className="flex flex-1 overflow-hidden relative">
                    {/* Sidebar / Tabs */}
                    <div className={`
                        absolute inset-y-0 left-0 z-10 w-64 bg-neutral-50 dark:bg-neutral-950 border-r border-neutral-200 dark:border-neutral-800
                        transform transition-transform duration-200 ease-in-out
                        md:relative md:translate-x-0
                        flex flex-col p-2 space-y-1 overflow-y-auto
                        ${isMobileMenuOpen ? 'translate-x-0 shadow-xl' : '-translate-x-full'}
                    `}>
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

                    {/* Overlay for mobile when menu is open */}
                    {isMobileMenuOpen && (
                        <div 
                            className="absolute inset-0 z-0 bg-black/20 md:hidden"
                            onClick={() => setIsMobileMenuOpen(false)}
                        />
                    )}

                    {/* Main Content Area */}
                    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-white dark:bg-neutral-900 scroll-smooth min-w-0">
                        {isLoading ? (
                            <div className="flex h-full items-center justify-center text-neutral-500 animate-pulse">
                                Loading archival data...
                            </div>
                        ) : error ? (
                            <div className="flex h-full items-center justify-center text-red-500">
                                {error}
                            </div>
                        ) : (
                            <article className="prose prose-neutral dark:prose-invert max-w-none min-w-0 w-full break-words">
                                <Markdown 
                                    components={{
                                        pre: ({node, ...props}) => (
                                            <div className="overflow-auto w-full my-4 rounded-lg bg-neutral-100 dark:bg-neutral-800 p-4">
                                                <pre {...props} className="whitespace-pre-wrap break-words" />
                                            </div>
                                        ),
                                        code: ({node, ...props}) => (
                                            <code {...props} className="bg-neutral-100 dark:bg-neutral-800 rounded px-1 py-0.5 break-words" />
                                        ),
                                        img: ({node, ...props}) => (
                                            <img {...props} className="max-w-full h-auto rounded-lg shadow-sm" />
                                        ),
                                        a: ({node, ...props}) => (
                                            <a {...props} className="text-primary hover:underline break-words" target="_blank" rel="noopener noreferrer" />
                                        )
                                    }}
                                >
                                    {content}
                                </Markdown>
                            </article>
                        )}
                    </div>
                </div>
            </Card>
        </div>
    );
};
