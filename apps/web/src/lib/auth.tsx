import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { apiFetch, unwrap, type AuthMe } from "./api";

export type { Role } from "./api";

interface AuthState {
  me: AuthMe | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<AuthMe | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const body = await apiFetch<unknown>("/auth/me");
      setMe(unwrap<AuthMe>(body));
    } catch {
      setMe(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiFetch("/auth/logout", { method: "POST", body: "{}" });
    } catch {
      /* ignore */
    }
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ me, loading, refresh, logout }), [me, loading, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

export function roleFromKey(key: string): AuthMe["role"] | null {
  if (key.startsWith("1dk_admin_")) return "admin";
  if (key.startsWith("1dk_consumer_")) return "consumer";
  if (key.startsWith("1dk_provider_")) return "provider";
  if (key.startsWith("1dk_ops_")) return "ops";
  return null;
}
