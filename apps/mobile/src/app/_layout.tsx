import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { settingsHydration, useSettings } from '@/lib/store';
import { useTheme } from '@/lib/theme';

export default function RootLayout() {
  const t = useTheme();
  const apiUrl = useSettings((s) => s.apiUrl);

  useEffect(() => {
    // Atualiza o mapa anunciado pelo servidor. Sem conexão, fica o estilo gravado (ou o público).
    void settingsHydration.then(() => api.health()).catch(() => {});
  }, [apiUrl]);

  return (
    <SafeAreaProvider>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerTintColor: t.text,
          headerStyle: { backgroundColor: t.surface },
          headerTransparent: false,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false, title: 'Mapa' }} />
        <Stack.Screen name="insights" options={{ title: 'Aprendizado' }} />
        <Stack.Screen name="settings" options={{ title: 'Ajustes' }} />
      </Stack>
    </SafeAreaProvider>
  );
}
