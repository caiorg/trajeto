import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { randomUUID } from 'expo-crypto';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * URL padrão da API: variável EXPO_PUBLIC_API_URL; senão, o IP da máquina que serve o
 * bundle em desenvolvimento (funciona em aparelho físico na mesma rede); senão localhost.
 */
function defaultApiUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) return process.env.EXPO_PUBLIC_API_URL;
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host && Platform.OS !== 'web') return `http://${host}:8787`;
  if (Platform.OS === 'android') return 'http://10.0.2.2:8787';
  return 'http://localhost:8787';
}

export type ThemePref = 'system' | 'light' | 'dark';

interface Settings {
  userId: string;
  apiUrl: string;
  voice: boolean;
  theme: ThemePref;
  avoidTolls: boolean;
  avoidHighways: boolean;
  set: (patch: Partial<Omit<Settings, 'set' | 'userId'>>) => void;
}

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      userId: randomUUID(),
      apiUrl: defaultApiUrl(),
      voice: true,
      theme: 'system',
      avoidTolls: false,
      avoidHighways: false,
      set: (patch) => set(patch),
    }),
    { name: 'trajeto-settings', storage: createJSONStorage(() => AsyncStorage) },
  ),
);

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  } catch {
    return 'America/Sao_Paulo';
  }
}
