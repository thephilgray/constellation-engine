# Phased Implementation Plan: Chat UI

This document outlines the plan for creating a modern, responsive chat interface for the Constellation Engine, using Astro, React, Tailwind CSS, and `shadcn/ui`.

### **Phase 1: Setup & Scaffolding**

**Goal:** Prepare the development environment by integrating necessary UI libraries and creating the foundational file structure.

1.  **Integrate Tailwind CSS:**
    *   Run `npx astro add tailwind` to automatically install and configure Tailwind CSS for the Astro project. This will create `tailwind.config.mjs` and `astro.config.mjs` will be updated.

2.  **Initialize `shadcn/ui`:**
    *   Run `npx shadcn-ui@latest init` to set up the `shadcn/ui` component library. This command will configure `tailwind.config.mjs`, `tsconfig.json`, and create a `components.json` file.
    *   Install core `shadcn/ui` components that will be used, such as `Button`, `Input`, and `Card`.

3.  **Create File Structure:**
    *   Create a new page for the chat interface:
        *   `src/pages/chat.astro`
    *   Create a new directory for the React-based chat components:
        *   `src/components/chat/`
    *   Inside the new directory, create the following component files:
        *   `ChatContainer.tsx` (The main stateful component)
        *   `MessageList.tsx` (To display the conversation)
        *   `Message.tsx` (To render a single chat bubble)
        *   `ChatInput.tsx` (The form for user input)

### **Phase 2: Static UI Implementation**

**Goal:** Build the visual components of the chat interface with placeholder data to establish the look and feel.

1.  **Build `ChatPage.astro`:**
    *   This page will import and render the main `ChatContainer.tsx` React component, making it visible within the Astro application.

2.  **Develop Core Components:**
    *   **`ChatContainer.tsx`**: Structure this component to hold the `MessageList` and `ChatInput` components.
    *   **`MessageList.tsx`**: Implement to render a hardcoded array of sample messages, demonstrating both user and AI message types.
    *   **`Message.tsx`**: Style this component to visually distinguish between messages sent by the user and messages received from the AI assistant. Use alignment and color differences.
    *   **`ChatInput.tsx`**: Build the input form using `shadcn/ui` components for the text area and the send button.

3.  **Styling:**
    *   Apply a clean, modern, dark-themed design using Tailwind CSS utility classes. The interface should be structured with a main chat panel that fills the screen.

### **Phase 3: State Management & Interactivity**

**Goal:** Breathe life into the static components by adding local state management and simulating a conversation.

1.  **Implement State:**
    *   In `ChatContainer.tsx`, use React's `useState` hook to manage the list of messages in the conversation and the content of the user input field.

2.  **Handle User Input:**
    *   Connect the `ChatInput.tsx` component to the state. The input field should be a controlled component, and the "Send" button should trigger a function in `ChatContainer`.

3.  **Simulate a Conversation:**
    *   On "Send", the user's message should be added to the messages array in the state.
    *   To mimic the asynchronous nature of a real backend, use `setTimeout` to add a hardcoded AI response to the messages array after a short delay.

4.  **Implement Loading State:**
    *   Add a new piece of state, `isLoading`, which is set to `true` after the user sends a message and `false` after the simulated AI response is received.
    *   Use this state to display a loading indicator (e.g., a simple "thinking..." message or a spinner) in the UI.

### **Phase 4: API Integration & Final Polish**

**Goal:** Connect the frontend UI to the backend, handle real data, and add final touches.

1.  **Connect to Backend API:**
    *   Replace the `setTimeout` simulation with a `fetch` call to the real chat API endpoint. The user's message will be sent in the request body.

2.  **Handle API Responses:**
    *   When the backend responds, add the AI's message to the chat history and set `isLoading` to `false`.

3.  **Error Handling:**
    *   Implement robust error handling for the API call. If the request fails, display a user-friendly error message within the chat interface.

4.  **Markdown Rendering:**
    *   Install a library like `react-markdown`.
    *   In the `Message.tsx` component, use this library to parse and render the AI's responses, allowing for formatted text, lists, code blocks, etc.

5.  **Final Polish:**
    *   Ensure the chat is responsive and works well on different screen sizes.
    *   Add a feature for the chat to automatically scroll to the latest message.
    *   Refine styles and animations.
