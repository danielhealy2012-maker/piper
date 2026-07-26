export type UserId = "you" | "sam";

export interface SeedUser {
  id: UserId;
  name: string;
  initials: string;
  color: string;
}

export const USERS: SeedUser[] = [
  { id: "you", name: "You", initials: "You", color: "#0a84ff" },
  { id: "sam", name: "Sam", initials: "S", color: "#ff2d55" },
];

export interface SeedMessage {
  id: string;
  authorId: UserId;
  text: string;
  time: string;
  // Emoji reactions added via the action router ("react to Sam's message with 🔥").
  reactions?: string[];
}

// "you" is the outgoing side. Generic weekend-dinner-plans content only.
export const SEED_MESSAGES: SeedMessage[] = [
  { id: "m1", authorId: "sam", text: "hey! any plans for dinner Saturday?", time: "9:38 AM" },
  { id: "m2", authorId: "you", text: "not yet, want to try that new ramen place?", time: "9:39 AM" },
  { id: "m3", authorId: "sam", text: "yes!! been wanting to go, great idea 🎉", time: "9:40 AM" },
  { id: "m4", authorId: "you", text: "awesome, I'll look up their hours", time: "9:41 AM" },
  { id: "m5", authorId: "sam", text: "¿puedes reservar para las siete?", time: "9:42 AM" },
  { id: "m6", authorId: "you", text: "on it, booking a table for 7pm", time: "9:44 AM" },
  { id: "m7", authorId: "sam", text: "perfect, see you then!", time: "9:45 AM" },
];
