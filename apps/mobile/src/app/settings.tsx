import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Switch, TextInput, View } from 'react-native';
import { Button, Card, Chip, T } from '@/components/ui';
import { api } from '@/lib/api';
import { useSettings, type ThemePref } from '@/lib/store';
import { useTheme } from '@/lib/theme';

export default function SettingsScreen() {
  const t = useTheme();
  const s = useSettings();
  const [url, setUrl] = useState(s.apiUrl);
  const [status, setStatus] = useState<string | null>(null);

  const test = async () => {
    s.set({ apiUrl: url.trim() });
    setStatus('Testando…');
    try {
      const h = await api.health();
      setStatus(h.ai ? `Conectado. IA: ${h.ai.provider} (${h.ai.model})` : 'Conectado. IA desativada: o copiloto usa regras.');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : 'Falha');
    }
  };

  useEffect(() => {
    void test();
    // Testa a conexão uma vez ao abrir.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const row = (label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) => (
    <View style={styles.row}>
      <View style={{ flex: 1 }}>
        <T>{label}</T>
        {hint ? <T variant="caption">{hint}</T> : null}
      </View>
      <Switch value={value} onValueChange={onChange} trackColor={{ true: t.primary, false: t.border }} />
    </View>
  );

  return (
    <ScrollView style={{ backgroundColor: t.bg }} contentContainerStyle={styles.content}>
      <Card style={{ gap: 10 }}>
        <T variant="title">Servidor</T>
        <TextInput
          value={url}
          onChangeText={setUrl}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { color: t.text, borderColor: t.border, backgroundColor: t.surfaceAlt }]}
          accessibilityLabel="URL da API"
        />
        <Button label="Salvar e testar" kind="secondary" icon="lan-connect" onPress={() => void test()} />
        {status ? <T variant="caption">{status}</T> : null}
      </Card>

      <Card style={{ gap: 14 }}>
        <T variant="title">Navegação</T>
        {row('Instruções por voz', s.voice, (v) => s.set({ voice: v }))}
        {row('Evitar pedágios', s.avoidTolls, (v) => s.set({ avoidTolls: v }), 'O app também aprende isso das suas escolhas.')}
        {row('Evitar rodovias', s.avoidHighways, (v) => s.set({ avoidHighways: v }))}
      </Card>

      <Card style={{ gap: 10 }}>
        <T variant="title">Tema</T>
        <View style={styles.chips}>
          {(['system', 'light', 'dark'] as ThemePref[]).map((p) => (
            <Chip key={p} label={{ system: 'Sistema', light: 'Claro', dark: 'Escuro' }[p]} selected={s.theme === p} onPress={() => s.set({ theme: p })} />
          ))}
        </View>
      </Card>

      <Card style={{ gap: 8 }}>
        <T variant="title">Identificador deste aparelho</T>
        <T variant="caption" style={{ fontFamily: 'monospace' }} color={t.text}>
          {s.userId}
        </T>
        <T variant="caption">
          Seu histórico de aprendizado fica associado a este id no servidor. Para ver o aprendizado sem dirigir, gere viagens de demonstração:
        </T>
        <T variant="caption" style={{ fontFamily: 'monospace' }} color={t.learn}>
          bun run seed --user {s.userId}
        </T>
      </Card>

      <T variant="caption" style={{ textAlign: 'center' }}>
        Mapas © OpenStreetMap e OpenFreeMap · Rotas Valhalla · Busca Photon · Clima Open-Meteo
      </T>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 14, maxWidth: 640, width: '100%', alignSelf: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chips: { flexDirection: 'row', gap: 8 },
  input: { height: 48, borderWidth: 1, borderRadius: 12, paddingHorizontal: 12, fontSize: 15 },
});
