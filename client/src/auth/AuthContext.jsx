// Holds the logged-in user for the whole app.
// `can(permission)` is used to hide UI the user is not allowed to use. This is
// a convenience only: the server enforces every permission on its own.

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api } from '../api/client.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  /** Asks the server who we are; logs the user out locally if the session is gone. */
  const refresh = useCallback(
    () =>
      api
        .get('/auth/me')
        .then((res) => setUser(res.user))
        .catch(() => setUser(null))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  const login = useCallback(async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    setUser(res.user);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
  }, []);

  const can = useCallback((permission) => Boolean(user?.permissions?.includes(permission)), [user]);

  return <AuthContext.Provider value={{ user, loading, login, logout, can, refresh }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
