
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
  skipBackup?: boolean;
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
