import {
  clearConversationMessages,
  deleteAllMessagesByAuthor,
  deleteMessage,
  editMessage,
  fetchMessages,
  fetchReactions,
  listMembers,
  loadTheme,
  saveTheme,
  sendMessage,
  subscribeConversation,
  toggleReaction,
  updateConversationTitle,
} from "./db";
import { requireSupabase } from "./supabase";
import { formatTime, type ChatMessage } from "./types";
import { DEFAULT_SPEC, type Spec } from "../engine/spec";
import { SEED_MESSAGES, USERS } from "../data/seed";

export interface DisplayUser {
  id: string;
  name: string;
  initials: string;
  color: string;
}

/**
 * Everything the chat UI needs, independent of where the data lives.
 * Two implementations: an in-memory demo backend (works with no credentials)
 * and the Supabase multiplayer backend.
 */
export interface ChatBackend {
  kind: "local" | "supabase";
  viewerId: string;
  getUsers(): Promise<DisplayUser[]>;
  fetchMessages(): Promise<ChatMessage[]>;
  /** Returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
  loadTheme(): Promise<Spec>;
  saveTheme(spec: Spec): Promise<void>;
  send(text: string): Promise<void>;
  edit(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Undo support: soft-deletes are reversible. */
  unremove(id: string): Promise<void>;
  /** Bulk delete: returns the ids actually removed, so callers can undo. */
  removeAllBy(authorId: string): Promise<string[]>;
  /** Toggles the emoji, so calling twice is its own inverse. */
  react(id: string, emoji: string): Promise<void>;
  updateTitle(title: string): Promise<void>;
  clearMessages(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Local demo backend — no accounts, no network, seeded conversation.
// ---------------------------------------------------------------------------

interface LocalState {
  messages: ChatMessage[];
  deleted: ChatMessage[];
  themes: Record<string, Spec>;
}

const localState: LocalState = {
  messages: SEED_MESSAGES.map((m) => ({
    id: m.id,
    authorId: m.authorId,
    text: m.text,
    time: m.time,
    reactions: m.reactions,
    isMine: false,
  })),
  deleted: [],
  themes: {},
};

const localListeners = new Set<() => void>();
const notifyLocal = () => localListeners.forEach((fn) => fn());

export function createLocalBackend(viewerId: string): ChatBackend {
  return {
    kind: "local",
    viewerId,
    async getUsers() {
      return USERS.map((u) => ({ id: u.id, name: u.name, initials: u.initials, color: u.color }));
    },
    async fetchMessages() {
      return localState.messages.map((m) => ({ ...m, isMine: m.authorId === viewerId }));
    },
    subscribe(onChange) {
      localListeners.add(onChange);
      return () => localListeners.delete(onChange);
    },
    async loadTheme() {
      return localState.themes[viewerId] ?? DEFAULT_SPEC;
    },
    async saveTheme(spec) {
      localState.themes[viewerId] = spec;
    },
    async send(text) {
      localState.messages = [
        ...localState.messages,
        {
          id: crypto.randomUUID(),
          authorId: viewerId,
          text,
          time: formatTime(new Date().toISOString()),
          isMine: true,
        },
      ];
      notifyLocal();
    },
    async edit(id, text) {
      localState.messages = localState.messages.map((m) => (m.id === id ? { ...m, text } : m));
      notifyLocal();
    },
    async remove(id) {
      const target = localState.messages.find((m) => m.id === id);
      if (target) localState.deleted.push(target);
      localState.messages = localState.messages.filter((m) => m.id !== id);
      notifyLocal();
    },
    async unremove(id) {
      const target = localState.deleted.find((m) => m.id === id);
      if (!target) return;
      localState.deleted = localState.deleted.filter((m) => m.id !== id);
      localState.messages = [...localState.messages, target].sort((a, b) =>
        a.time === b.time ? 0 : a.time < b.time ? -1 : 1,
      );
      notifyLocal();
    },
    async removeAllBy(authorId) {
      const targets = localState.messages.filter((m) => m.authorId === authorId);
      localState.deleted.push(...targets);
      localState.messages = localState.messages.filter((m) => m.authorId !== authorId);
      notifyLocal();
      return targets.map((m) => m.id);
    },
    async react(id, emoji) {
      localState.messages = localState.messages.map((m) => {
        if (m.id !== id) return m;
        const current = m.reactions ?? [];
        return {
          ...m,
          reactions: current.includes(emoji)
            ? current.filter((e) => e !== emoji)
            : [...current, emoji],
        };
      });
      notifyLocal();
    },
    async updateTitle(_title) {
      // Local demo doesn't have conversation titles
    },
    async clearMessages() {
      localState.messages = [];
      notifyLocal();
    },
  };
}

// ---------------------------------------------------------------------------
// Supabase multiplayer backend
// ---------------------------------------------------------------------------

function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/\s+/);
  return (parts.length > 1 ? parts[0][0] + parts[1][0] : trimmed.slice(0, 2)).toUpperCase();
}

export function createSupabaseBackend(conversationId: string, userId: string): ChatBackend {
  return {
    kind: "supabase",
    viewerId: userId,
    async getUsers() {
      const profiles = await listMembers(conversationId);
      return profiles.map((p) => ({
        id: p.id,
        name: p.display_name,
        initials: initialsOf(p.display_name),
        color: p.avatar_color,
      }));
    },
    async fetchMessages() {
      const [rows, reactions] = await Promise.all([
        fetchMessages(conversationId),
        fetchReactions(conversationId),
      ]);
      const byMessage = new Map<string, string[]>();
      for (const r of reactions) {
        const list = byMessage.get(r.message_id) ?? [];
        list.push(r.emoji);
        byMessage.set(r.message_id, list);
      }
      return rows.map((r) => ({
        id: r.id,
        authorId: r.author_id,
        text: r.body,
        time: formatTime(r.created_at),
        reactions: byMessage.get(r.id),
        isMine: r.author_id === userId,
        editedAt: r.edited_at,
      }));
    },
    subscribe(onChange) {
      const channel = subscribeConversation(conversationId, onChange);
      return () => {
        void requireSupabase().removeChannel(channel);
      };
    },
    loadTheme: () => loadTheme(conversationId, userId),
    saveTheme: (spec) => saveTheme(conversationId, userId, spec),
    send: (text) => sendMessage(conversationId, userId, text),
    edit: (id, text) => editMessage(id, text),
    remove: (id) => deleteMessage(id),
    async unremove(id) {
      const sb = requireSupabase();
      await sb.from("messages").update({ deleted_at: null }).eq("id", id);
    },
    react: (id, emoji) => toggleReaction(id, userId, emoji),
    updateTitle: (title) => updateConversationTitle(conversationId, title),
    clearMessages: () => clearConversationMessages(conversationId),
    removeAllBy: (authorId) => deleteAllMessagesByAuthor(conversationId, authorId),
  };
}
