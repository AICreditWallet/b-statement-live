// frontend/auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

// ✅ Put your Supabase values here (Supabase → Project Settings → API)
const SUPABASE_URL = "https://vqhezyceqmkltjpzgfkb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxaGV6eWNlcW1rbHRqcHpnZmtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2MTkwMDQsImV4cCI6MjA4NDE5NTAwNH0.HcF-4Uv3PTrcqY43-cTtqnbd_3YKiGONaeIhiKrd28c";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---- Session helpers (uses Supabase session; localStorage is managed by Supabase SDK) ----

export async function createAccount({ name, email, password }) {
  name = (name || "").trim();
  email = (email || "").trim().toLowerCase();
  password = (password || "").trim();

  if (!name) throw new Error("Name is required.");
  if (!email || !email.includes("@")) throw new Error("Valid email is required.");
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name }
    }
  });

  if (error) throw new Error(error.message);

  // Note: if email confirmation is ON, session may be null until they confirm.
  return {
    id: data?.user?.id || null,
    name,
    email
  };
}

export async function login({ email, password }) {
  email = (email || "").trim().toLowerCase();
  password = (password || "").trim();

  if (!email || !email.includes("@")) throw new Error("Enter a valid email.");
  if (!password) throw new Error("Enter your password.");

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);

  const user = data?.user;
  return {
    id: user?.id || null,
    name: user?.user_metadata?.name || "",
    email: user?.email || email
  };
}

export async function logout() {
  await supabase.auth.signOut();
}

export async function currentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const u = data.user;
  return {
    name: u.user_metadata?.name || "",
    email: u.email || "",
    userId: u.id
  };
}

// ---- Your existing “local data” helpers can stay (for invoices/history stored per user on device) ----

export function clearMyData(userId) {
  if (!userId) return;
  localStorage.removeItem(`spw_history_${userId}`);
  localStorage.removeItem(`spw_invoices_${userId}`);
}

export async function deleteAccount() {
  // IMPORTANT:
  // You cannot safely delete Supabase Auth users from the browser using anon key.
  // That requires a backend (service role key) or Supabase Edge Function.
  //
  // For now: clear local data + sign out.
  const me = await currentUser();
  if (!me?.userId) throw new Error("No logged-in user.");

  clearMyData(me.userId);
  await logout();

  // If you want true account deletion later:
  // we’ll add a backend endpoint /delete-user using SERVICE_ROLE_KEY (server-only).
  return true;
}