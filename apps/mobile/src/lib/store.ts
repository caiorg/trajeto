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

/** Chave usada antes da renomeação para Wayboo. É lida uma vez para manter o `userId` e as preferências. */
const LEGACY_SETTINGS_KEY = 'trajeto-settings';

/** AsyncStorage que, sem valor na chave nova, move o da chave antiga para ela. */
const settingsStorage = createJSONStorage(() => ({
  getItem: async (name: string) => {
    const value = await AsyncStorage.getItem(name);
    if (value !== null) return value;
    const legacy = await AsyncStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy !== null) {
      await AsyncStorage.setItem(name, legacy);
      await AsyncStorage.removeItem(LEGACY_SETTINGS_KEY);
    }
    return legacy;
  },
  setItem: (name: string, value: string) => AsyncStorage.setItem(name, value),
  removeItem: (name: string) => AsyncStorage.removeItem(name),
}));

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
    { name: 'wayboo-settings', storage: settingsStorage },
  ),
);

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  } catch {
    return 'America/Sao_Paulo';
  }
}
