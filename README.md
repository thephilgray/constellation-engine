# 🌌 Constellation Engine
A Serverless, AI-Powered Operating System for Creativity.

The Constellation Engine is a personal "Second Brain" designed to bridge the gap between High-Throughput Ideation (fleeting thoughts, dreams, random ideas) and High-Latency Processing (writing, synthesis, archiving).

Instead of a static note-taking app, it is a living system where an AI "Gardener" actively tends to my data—clustering thoughts, checking story continuity, and analyzing dream symbols—every time I hit save.

🏗 Architecture
The system runs entirely on AWS Serverless infrastructure using SST v3. It treats iOS Shortcuts as a "Headless UI" and Obsidian (via GitHub) as the frontend interface.

Input: iOS Shortcuts (supports Text, Dictation, Share Sheet).

Compute: AWS Lambda (Node.js).

Memory: Pinecone (Serverless Vector Database).

Reasoning: Google Gemini 1.5 Pro (Large Context Window).

Storage: GitHub Repository (Synced to local Obsidian vault).

🧩 The "Sidecar" Modules
The engine uses a "Sidecar Pattern," routing different types of input to specialized AI personas that maintain their own stateful dashboards.

1. 🧠 The Thought Engine (Main)
Input: Random ideas, writing drafts, external sources.

Role: The Gardener.

Function: Clusters loose thoughts into "Constellations" (emergent topics). Distinguishes between raw Ideas (seeds), active Drafts (plants), and Sources (fertilizer).

Output: 00_Current_Constellations.md

2. 📖 The Lore Keeper (Fiction)
Input: Scene drafts, plot twists, world-building notes.

Role: The Continuity Editor.

Function: Maintains a "Living Story Bible." Tracks character relationships and world rules. Splits raw Scenes (preserved text) from Ideas (meta-data). Flags plot holes if new input contradicts established lore.

Output: 00_Story_Bible.md

3. 🧬 The Biographer (Life Log)
Input: Daily journal entries, recovered memories.

Role: The Family Archivist.

Function: A unified log for the past and present. Analyzes Journal entries for current mood and Memories for life milestones. Uses vector search to surface past memories that resonate with today's events.

Output: 00_Life_Log.md

4. 🌙 The Dream Logger
Input: Morning dream descriptions.

Role: The Jungian Analyst.

Function: Tracks recurring symbols, archetypes, and emotional tones over time.

Output: 00_Dream_Journal.md

5. 🎵 The Lyric Lab
Input: Song lines, rhymes, structural ideas.

Role: The Session Musician.

Function: Analyzes meter and rhyme schemes rather than just semantic meaning. Groups "Orphan Lines" into potential songs.

Output: 00_Lyric_Lab.md

🚀 Tech Stack
Framework: SST v3 (Ion)

Language: TypeScript

AI Model: Gemini 2.5 Flash

Vector DB: Pinecone

File Storage: GitHub API
