// Shared domain types for the multiplayer app. These mirror the SQL schema in
// supabase/migrations/0001_init.sql.

export interface Profile {
  id: string;
  display_name: string;
  avatar_color: string;
}

export interface Conversation {
  id: string;
  title: string;
  created_by: string;
  invite_code: string;
}

export interface DbMessage {
  id: string;
  conversation_id: string;
  author_id: string;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export interface DbReaction {
  message_id: string;
  user_id: string;
  emoji: string;
}

export interface DbPoll {
  id: string;
  conversation_id: string;
  created_by: string;
  question: string;
  options: string[];
  created_at: string;
}

export interface DbPollVote {
  poll_id: string;
  user_id: string;
  option_index: number;
}

// The view model the Chat component renders. Keeps the same shape the existing
// components already expect (id/text/time) so the renderer didn't have to change,
// plus the multiplayer fields.
export interface ChatMessage {
  id: string;
  authorId: string;
  text: string;
  time: string;
  reactions?: string[];
  isMine: boolean;
  editedAt?: string | null;
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
