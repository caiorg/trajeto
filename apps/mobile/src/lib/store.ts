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

/** Mesma forma na chave das credenciais e no envio: `https://x/` e `https://x` são o mesmo servidor. */
export function normalizeApiUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Credencial deste aparelho num servidor. O aparelho gera o token e o grava antes de registrá-lo;
 * `userId` só existe depois que `POST /auth/device` confirmou o registro.
 */
export interface DeviceCredential {
  token: string;
  userId?: string;
}

interface Settings {
  /** UUID anônimo do aparelho, de antes dos tokens. Vai em `legacyUserId` para o servidor adotar os dados antigos. */
  userId: string;
  /** Uma credencial por servidor (chave: `normalizeApiUrl`), para voltar a um servidor sem perder a identidade. */
  credentials: Record<string, DeviceCredential>;
  apiUrl: string;
  voice: boolean;
  theme: ThemePref;
  avoidTolls: boolean;
  avoidHighways: boolean;
  set: (patch: Partial<Omit<Settings, 'set' | 'setCredential' | 'userId' | 'credentials'>>) => void;
  setCredential: (apiUrl: string, credential: DeviceCredential) => void;
}

/** Resolve com o erro da leitura do AsyncStorage (ou `null`) quando a hidratação termina. */
let finishHydration: (error: unknown) => void = () => {};
export const settingsHydration = new Promise<unknown>((resolve) => {
  finishHydration = resolve;
});

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      userId: randomUUID(),
      credentials: {},
      apiUrl: defaultApiUrl(),
      voice: true,
      theme: 'system',
      avoidTolls: false,
      avoidHighways: false,
      set: (patch) => set(patch),
      setCredential: (apiUrl, credential) =>
        set((s) => ({ credentials: { ...s.credentials, [normalizeApiUrl(apiUrl)]: credential } })),
    }),
    {
      name: 'wayboo-settings',
      storage: settingsStorage,
      // O zustand não marca `hasHydrated` nem avisa `onFinishHydration` quando a leitura falha.
      onRehydrateStorage: () => (_state, error) => finishHydration(error ?? null),
    },
  ),
);

export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  } catch {
    return 'America/Sao_Paulo';
  }
}
