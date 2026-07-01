import axios from "axios";
import { emitSessionExpired } from "@/lib/sessionEvents";

const api = axios.create({
  baseURL: (import.meta.env.VITE_API_URL ?? "http://localhost:8000") + "/api/v1",
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("docke_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// Track whether we're already showing the session-expired overlay to avoid
// flooding the event bus when multiple concurrent requests all return 401.
let sessionExpiredFired = false;

api.interceptors.response.use(
  (res) => res,
  (err) => {
    if (err.response?.status === 401 && !sessionExpiredFired) {
      sessionExpiredFired = true;
      emitSessionExpired();
      // Reset flag after a delay so re-auth attempts can trigger it again if needed
      setTimeout(() => { sessionExpiredFired = false; }, 3000);
    }
    return Promise.reject(err);
  }
);

export default api;
