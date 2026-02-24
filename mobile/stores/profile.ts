import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../services/api';

export interface ProfileData {
    height: number | null;
    weight: number | null;
    age: number | null;
    gender: string | null;
    training_goal: string | null;
    experience_level: string | null;
}

interface ProfileState {
    profile: ProfileData | null;
    isLoading: boolean;
    lastUpdated: number | null; // 用于缓存时间判断

    fetchProfile: (force?: boolean) => Promise<void>;
    clearProfile: () => void;
}

export const useProfileStore = create<ProfileState>()(
    persist(
        (set, get) => ({
            profile: null,
            isLoading: false,
            lastUpdated: null,

            fetchProfile: async (force = false) => {
                // 如果不是强刷，且有了缓存数据，那就不显示全屏 Loading（由页面本身决定用不用 skeleton）
                const hasCache = !!get().profile;
                if (!hasCache || force) {
                    set({ isLoading: true });
                }

                try {
                    const res = await api.getProfile();
                    if (res.success && res.data) {
                        set({
                            profile: res.data as ProfileData,
                            lastUpdated: Date.now(),
                        });
                    }
                } catch (err) {
                    console.error('Fetch Profile Failed:', err);
                } finally {
                    set({ isLoading: false });
                }
            },

            clearProfile: () => set({ profile: null, lastUpdated: null }),
        }),
        {
            name: 'lianlema-profile-storage', // AsyncStorage 命名空间
            storage: createJSONStorage(() => AsyncStorage),
        }
    )
);
