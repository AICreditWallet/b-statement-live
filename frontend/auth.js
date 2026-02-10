// frontend/auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

// ✅ Supabase config
const SUPABASE_URL = "https://vqhezyceqmkltjpzgfkb.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxaGV6eWNlcW1rbHRqcHpnZmtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2MTkwMDQsImV4cCI6MjA4NDE5NTAwNH0.HcF-4Uv3PTrcqY43-cTtqnbd_3YKiGONaeIhiKrd28c";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------------------------
// ✅ Synchronous currentUser()
// ---------------------------
// Supabase stores session in localStorage under:
// sb-<project_ref>-auth-token
const PROJECT_REF = "vqhezyceqmkltjpzgfkb";
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

function readSupabaseUserFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);

    // Supabase v2 format typically includes { user: {...}, access_token, ... }
    const u = parsed?.user;
    if (!u?.id) return null;

    return {
      name: u.user_metadata?.name || "",
      email: u.email || "",
      userId: u.id,
    };
  } catch {
    return null;
  }
}

// ✅ This stays synchronous so your existing dashboard/login/register scripts work
export function currentUser() {
  return readSupabaseUserFromStorage();
}

// Optional async version (for future use)
export async function currentUserAsync() {
  const { data } = await supabase.auth.getUser();
  const u = data?.user;
  if (!u) return null;
  return {
    name: u.user_metadata?.name || "",
    email: u.email || "",
    userId: u.id,
  };
}

// ---------------------------
// Auth actions
// ---------------------------
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
    options: { data: { name } },
  });

  if (error) throw new Error(error.message);

  return {
    id: data?.user?.id || null,
    name,
    email,
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
    email: user?.email || email,
  };
}

export async function logout() {
  await supabase.auth.signOut();
}

// ---------------------------
// Local-only data helpers (still fine for now)
// ---------------------------
export function clearMyData(userId) {
  if (!userId) return;
  localStorage.removeItem(`spw_history_${userId}`);
  localStorage.removeItem(`spw_invoices_${userId}`);
}

export async function deleteAccount() {
  // Cannot delete Supabase Auth users from browser with anon key
  const me = currentUser();
  if (!me?.userId) throw new Error("No logged-in user.");

  clearMyData(me.userId);
  await logout();
  return true;
}
