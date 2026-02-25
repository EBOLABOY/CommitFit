import { create } from 'zustand';
import { api, setToken, clearToken } from '../services/api';

interface User {
  id: string;
  email: string;
  nickname: string | null;
  avatar_key: string | null;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, nickname?: string) => Promise<void>;
  logout: () => Promise<void>;
  setUser: (user: User) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: false,

  login: async (email, password) => {
    set({ isLoading: true });
    try {
      const res = await api.login(email, password);
      if (!res.success) throw new Error(res.error || '登录失败');
      const data = res.data as { token: string; user: User };
      await setToken(data.token);
      set({ user: data.user, isAuthenticated: true });
    } finally {
      set({ isLoading: false });
    }
  },

  register: async (email, password, nickname) => {
    set({ isLoading: true });
    try {
      const res = await api.register(email, password, nickname);
      if (!res.success) throw new Error(res.error || '注册失败');
      const data = res.data as { token: string; user: User };
      await setToken(data.token);
      set({ user: data.user, isAuthenticated: true });
    } finally {
      set({ isLoading: false });
    }
  },

  logout: async () => {
    await clearToken();
    set({ user: null, isAuthenticated: false });
  },

  setUser: (user) => set({ user, isAuthenticated: true }),
}));
