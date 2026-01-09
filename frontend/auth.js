// frontend/auth.js
// MVP-only auth using LocalStorage. Not secure for production.

const USERS_KEY = "spw_users_v1";
const SESSION_KEY = "spw_session_v1";

function loadUsers() {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY)) || [];
  } catch {
    return [];
  }
}

function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY)) || null;
  } catch {
    return null;
  }
}

function setSession(session) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function sha256(text) {
  // Best-effort hashing. Still not “secure” because it’s client-side.
  if (window.crypto?.subtle) {
    const enc = new TextEncoder().encode(text);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback if SubtleCrypto not available
  return btoa(unescape(encodeURIComponent(text)));
}

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

  const users = loadUsers();
  if (users.some(u => u.email === email)) throw new Error("Account already exists for this email.");

  const passwordHash = await sha256(password);
  const user = { id: crypto.randomUUID?.() || String(Date.now()), name, email, passwordHash, createdAt: Date.now() };
  users.push(user);
  saveUsers(users);

  // Auto-login after signup
  setSession({ userId: user.id, email: user.email, name: user.name, loggedInAt: Date.now() });
  return { id: user.id, name: user.name, email: user.email };
}

export async function login({ email, password }) {
  email = normalizeEmail(email);
  password = (password || "").trim();

  if (!email || !email.includes("@")) throw new Error("Enter a valid email.");
  if (!password) throw new Error("Enter your password.");

  const users = loadUsers();
  const user = users.find(u => u.email === email);
  if (!user) throw new Error("No account found for this email.");

  const passwordHash = await sha256(password);
  if (passwordHash !== user.passwordHash) throw new Error("Incorrect password.");

  setSession({ userId: user.id, email: user.email, name: user.name, loggedInAt: Date.now() });
  return { id: user.id, name: user.name, email: user.email };
}

export function logout() {
  clearSession();
}

export function currentUser() {
  const s = getSession();
  return s ? { name: s.name, email: s.email, userId: s.userId } : null;
}
// Add these to auth.js

export function clearMyData(userId) {
  if (!userId) return;
  localStorage.removeItem(`spw_history_${userId}`);
  localStorage.removeItem(`spw_invoices_${userId}`);
}

export async function deleteAccount() {
  // Removes current account from this device + clears session + data
  const session = (() => {
    try { return JSON.parse(localStorage.getItem("spw_session_v1")) || null; } catch { return null; }
  })();
  if (!session?.userId) throw new Error("No logged-in user.");

  const userId = session.userId;
  const email = (session.email || "").toLowerCase();

  // Remove user from users list
  const USERS_KEY = "spw_users_v1";
  let users = [];
  try { users = JSON.parse(localStorage.getItem(USERS_KEY)) || []; } catch {}
  users = users.filter(u => (u.email || "").toLowerCase() !== email);
  localStorage.setItem(USERS_KEY, JSON.stringify(users));

  // Clear local data and session
  clearMyData(userId);
  localStorage.removeItem("spw_session_v1");
}
