# Comprehensive Tech Spec: Constellation Engine

This document provides a detailed, step-by-step technical specification for refactoring the Constellation Engine to a "Unified Lake" architecture and implementing a new chat interface.

---

## **Part 1: Foundational Backend & Data Architecture**

**Objective:** Establish the core data models and cloud infrastructure.

### **Step 1: Define Data Schemas**
Create a new file at `src/lib/schemas.ts` to serve as the single source of truth for data structures.

```typescript
// src/lib/schemas.ts
export interface ConstellationRecord {
  // Core Keys for Single-Table Design
  PK: `USER#${string}`;
  SK: `ENTRY#${string}` | `METADATA`;

  // Universal Attributes
  id: string;
  type: 'Entry' | 'User';
  createdAt: string;
  updatedAt: string;

  // Entry-Specific Attributes
  content: string;
  isOriginal: boolean;
  sourceURL?: string;
  sourceTitle?: string;
  sourceAuthor?: string;
  mediaType?: 'text' | 'audio' | 'image';
  s3_url?: string;
  tags?: string[];
  lastAccessed: string;
}

export interface PineconeMetadata {
  id: string;
  userId: string;
  isOriginal: boolean;
  mediaType: 'text' | 'audio' | 'image';
  createdAt: string;
  tags: string[];
}

export interface IntentRouterOutput {
  isOriginal: boolean;
  sourceURL?: string;
  sourceTitle?: string;
  sourceAuthor?: string;
  content: string;
  tags: string[];
  mediaType: 'text' | 'audio' | 'image';
}
```

### **Step 2: Define "Intent Router" System Prompt**
This prompt will be used by a `gemini-1.5-flash` model to process and classify all incoming data.

```text
# System Prompt: Constellation Engine Intent Router

You are a hyper-efficient data processing engine for a 'Second Brain' application. Your sole purpose is to receive a piece of content, analyze it, and return a structured JSON object.

**RULES:**
1.  **Analyze the Input:** The user will provide a block of text, a URL, or a reference to an uploaded file.
2.  **Determine Originality:**
    *   If the content appears to be the user's own thoughts, set `isOriginal: true`.
    *   If it contains quotes, is a direct paste from a web article, or is a URL, set `isOriginal: false`.
3.  **Extract Source (if `isOriginal: false`):**
    *   If a URL is present, populate `sourceURL`.
    *   Attempt to identify `sourceTitle` and `sourceAuthor` from the text if available.
4.  **Process Multimedia:**
    *   **For Audio:** Assume the input is a transcription. Extract the core message into `content`. Generate `tags` describing the emotional tone (e.g., "emotional_tone: excited"). Set `mediaType: 'audio'`.
    *   **For Images:** Assume the input is a description of an image. Summarize the description into `content`. Generate `tags` describing the key visual concepts (e.g., "concept: UML Diagram", "style: hand-drawn"). Set `mediaType: 'image'`.
    *   **For Text:** The input is the content. Set `mediaType: 'text'`.
5.  **Output JSON ONLY:** Your entire response MUST be a single, valid JSON object matching the `IntentRouterOutput` interface. Do not include any explanations or conversational text.

**JSON OUTPUT FORMAT:**
{
  "isOriginal": boolean,
  "sourceURL": string | null,
  "sourceTitle": string | null,
  "sourceAuthor": string | null,
  "content": string,
  "tags": string[],
  "mediaType": "text" | "audio" | "image"
}
```

### **Step 3: Configure SST for Core Infrastructure**
Modify `sst.config.ts` to define the new architecture.

```typescript
// sst.config.ts
export default $config({
  // ... app config
  async run() {
    const GOOGLE_BOOKS_API_KEY = new sst.Secret("GOOGLE_BOOKS_API_KEY");
    const GOOGLE_CLIENT_ID = new sst.Secret("GOOGLE_CLIENT_ID");
    const GOOGLE_CLIENT_SECRET = new sst.Secret("GOOGLE_CLIENT_SECRET");

    // NEW: Authentication (with Google Identity Provider)
    const auth = new sst.aws.CognitoUserPool("Auth", {
      identityProviders: {
        google: {
          clientId: GOOGLE_CLIENT_ID.value,
          clientSecret: GOOGLE_CLIENT_SECRET.value,
          scopes: ["email", "profile"],
        },
      },
    });
    auth.addClient("WebApp", {
      callBackUrls: ["http://localhost:5173", "YOUR_DEPLOYED_AUTH_URL"], // Placeholder, replace with actual URLs
      logoutUrls: ["http://localhost:5173", "YOUR_DEPLOYED_AUTH_URL"], // Placeholder, replace with actual URLs
    });

    // NEW: Multimedia Storage
    const bucket = new sst.aws.Bucket("AssetBucket");

    // NEW: The Unified Lake Table
    const table = new sst.aws.Dynamo("UnifiedLake", {
      fields: { PK: "string", SK: "string" },
      primaryIndex: { hashKey: "PK", rangeKey: "SK" },
      stream: "new_image",
    });

    // NEW: Async GitHub Backup Worker
    const githubBackupWorker = new sst.aws.Function("GitHubBackupWorker", {
      handler: "src/workers/githubBackup.handler",
      link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO],
    });
    table.subscribe(githubBackupWorker, {
      filters: [{ dynamodb: { NewImage: { type: { S: ["Entry"] } } } }]
    });

    // UPDATED: Link `table` to existing Librarian functions
    const librarianFunctions = {
      fetchContext: new sst.aws.Function("LibrarianFetchContext", {
        // ... existing config
        link: [/*...,*/ table],
      }),
      // ... repeat for all other librarian functions
    };

    // NEW: Secured Ingestion Endpoint
    const ingest = new sst.aws.Function("Ingest", {
      handler: "src/ingest.handler",
      timeout: "60 seconds",
      link: [ table, bucket, auth, /* ...other secrets... */ ],
      url: {
        authorizer: {
          jwt: {
            issuer: auth.issuer,
            audiences: [auth.userPoolClientId],
          },
        },
      },
    });

    return { ingestEndpoint: ingest.url, /* ... */ };
  },
});
```

---

## **Part 2: UI Scaffolding & Initial Setup**

**Objective:** Prepare the project for building the chat interface.

### **Step 4: Set up Tailwind CSS**
In the terminal, run the Astro command to add Tailwind CSS.
```bash
npx astro add tailwind
```

### **Step 5: Initialize `shadcn/ui`**
Run the `shadcn/ui` init command and follow the prompts.
```bash
npx shadcn-ui@latest init
```
Then, install the core components needed for the chat UI.
```bash
npx shadcn-ui@latest add button input card
```

### **Step 6: Create UI File Structure**
Create the necessary directories and empty files for the chat components.
- `src/pages/chat.astro`
- `src/components/chat/ChatContainer.tsx`
- `src/components/chat/MessageList.tsx`
- `src/components/chat/Message.tsx`
- `src/components/chat/ChatInput.tsx`

---

## **Part 3: Backend Implementation & Data Migration**

**Objective:** Build the core backend logic and migrate existing data.

### **Step 7: Implement Ingestion Handler**
Develop the Lambda function at `src/ingest.handler.ts`. Its logic will:
1.  Receive a request from the authenticated API Gateway endpoint.
2.  Use the "Intent Router" prompt and Gemini API to process the request body.
3.  Generate a vector embedding of the content.
4.  Save the resulting `ConstellationRecord` to the `UnifiedLake` DynamoDB table.
5.  Upsert the vector and `PineconeMetadata` to the Pinecone index.

### **Step 8: Implement GitHub Backup Worker**
Develop the Lambda function at `src/workers/githubBackup.handler.ts`. It will be triggered by the DynamoDB stream and will:
1.  Receive a new `Entry` record.
2.  Convert the record into a Markdown file with YAML frontmatter.
3.  Commit the file to the configured GitHub repository.

### **Step 9: Implement and Run "Lazarus" Migration Script**
Create and execute a one-time migration script at `scripts/migrateLegacy.ts`.
1.  Implement the `fetchLegacyFiles` function using `octokit` to read all markdown files from the old repository.
2.  Implement embedding generation logic.
3.  Loop through each file, pass its content to the "Intent Router", and save the resulting record to both DynamoDB and Pinecone.
4.  Execute the script with `sst run npx tsx scripts/migrateLegacy.ts`.

---

## **Part 4: Frontend Implementation & Interactivity**

**Objective:** Build a functional, interactive chat interface with local state.

### **Step 10: Build Static UI Components**
Flesh out the React components created in Step 6.
-   **`ChatPage.astro`**: Import and render the `ChatContainer`.
-   **`ChatContainer.tsx`**: Build the main layout to hold the message list and input form.
-   **`MessageList.tsx` & `Message.tsx`**: Render a hardcoded list of messages to establish the visual design, distinguishing between user and AI messages.
-   **`ChatInput.tsx`**: Build the input form using `shadcn/ui` components.

### **Step 11: Implement UI State Management**
In `ChatContainer.tsx`, use React's `useState` hook to manage:
-   An array of message objects.
-   The string value of the input field.
-   A boolean `isLoading` flag.

### **Step 12: Simulate Chat Interactivity**
1.  Make the input a controlled component.
2.  On "Send", add the user's message to the state and set `isLoading` to `true`.
3.  Use `setTimeout` to simulate a network request, then add a hardcoded AI response to the state and set `isLoading` to `false`.

---

## **Part 5: Full-Stack Integration & Finalization**

**Objective:** Connect all parts of the system and add final polish.

### **Step 13: Refactor Librarian Workflow**
Update the existing `Librarian` Step Functions workflow. Modify the relevant functions (`fetchContext`, `persistRecs`, etc.) to query and write to the `UnifiedLake` DynamoDB table instead of the legacy GitHub source.

### **Step 14: Connect Chat UI to Backend**
In `ChatContainer.tsx`:
1.  Replace the `setTimeout` simulation with a `fetch` call to the secure `/ingest` endpoint.
2.  Pass the user's message in the request body.
3.  On success, add the AI's response from the API to the message list.
4.  Implement error handling to display a message in the UI if the API call fails.

### **Step 15: Final UI Polish**
1.  Install `react-markdown` and use it in the `Message.tsx` component to render AI responses.
2.  Ensure the chat view automatically scrolls to the latest message.
3.  Verify the UI is responsive and looks good on all screen sizes.
4.  Refine styling, transitions, and animations.
