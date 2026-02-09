// frontend/auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

// Supabase → Project Settings → API
const SUPABASE_URL = "https://vqhezyceqmkltjpzgfkb.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZxaGV6eWNlcW1rbHRqcHpnZmtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg2MTkwMDQsImV4cCI6MjA4NDE5NTAwNH0.HcF-4Uv3PTrcqY43-cTtqnbd_3YKiGONaeIhiKrd28c";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,     // keep session across refreshes
    autoRefreshToken: true,   // refresh tokens automatically
    detectSessionInUrl: true, // handles magic links / oauth redirects
  },
});

// ------------------ Auth actions ------------------

function normalizeEmail(email) {
  return (email || "").trim().toLowerCase();
}

export async function createAccount({ name, email, password }) {
  name = (name || "").trim();
  email = normalizeEmail(email);
  password = (password || "").trim();

  if (!name) throw new Error("Name is required.");
  if (!email || !email.includes("@")) throw new Error("Valid email is required.");
  if (password.length < 6) throw new Error("Password must be at least 6 characters.");

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { name }, // stored in user_metadata
    },
  });

  if (error) throw new Error(error.message);

  // IMPORTANT:
  // If email confirmations are ON, data.session may be null until they confirm the email.
  return {
    id: data?.user?.id || null,
    name,
    email,
    session: data?.session || null,
  };
}

export async function login({ email, password }) {
  email = normalizeEmail(email);
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
  // Ensure client-side session is cleared
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(error.message);

  // Extra safety: clear any old local MVP session keys if they ever existed
  try { localStorage.removeItem("spw_session_v1"); } catch {}
}

// ------------------ Session helpers ------------------

export async function currentUser() {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;

  const u = data.user;
  return {
    name: u.user_metadata?.name || "",
    email: u.email || "",
    userId: u.id,
  };
}

// Page guard: use on dashboard
export async function requireAuth(redirectTo = "./login.html") {
  const u = await currentUser();
  if (!u) {
    window.location.href = redirectTo;
    return null;
  }
  return u;
}

// Page guard: use on login/register (if already logged in)
export async function redirectIfLoggedIn(redirectTo = "./dashboard.html") {
  const u = await currentUser();
  if (u) window.location.href = redirectTo;
}

// ------------------ Local data helpers (OK to stay local) ------------------
// NOTE: These are NOT accounts. This is just per-device cached invoice history.
export function clearMyData(userId) {
  if (!userId) return;
  localStorage.removeItem(`spw_history_${userId}`);
  localStorage.removeItem(`spw_invoices_${userId}`);
}

// IMPORTANT:
// You cannot delete Supabase Auth users securely from the browser with anon key.
// That requires backend/service role or an Edge Function.
// For now: clear local data + logout
export async function deleteAccountLocalOnly() {
  const me = await currentUser();
  if (!me?.userId) throw new Error("No logged-in user.");
  clearMyData(me.userId);
  await logout();
  return true;
}
