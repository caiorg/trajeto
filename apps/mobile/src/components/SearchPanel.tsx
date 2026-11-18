import type { LatLon } from '@wayboo/core';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Keyboard, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { api, type GeocodeResult } from '@/lib/api';
import { useTheme } from '@/lib/theme';
import { Icon, shadow, T } from './ui';

/** Frases que indicam pedido em linguagem natural, não só um endereço. */
const NATURAL = /\b(me leva|quero|preciso|sem|evit|passando|parando|chegar|sair|pra casa|pro trabalho|caminho de sempre)\b/i;

export function SearchPanel({
  near,
  onPick,
  onAsk,
  busy,
}: {
  near: LatLon | null;
  onPick: (r: GeocodeResult) => void;
  onAsk: (text: string) => void;
  busy: boolean;
}) {
  const t = useTheme();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<GeocodeResult[]>([]);
  const [focused, setFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const text = q.trim();
    if (text.length < 3 || NATURAL.test(text)) {
      setResults([]);
      return;
    }
    const id = ++seq.current;
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await api.geocode(text, near ?? undefined);
        if (id === seq.current) setResults(r.results);
      } catch {
        if (id === seq.current) setResults([]);
      } finally {
        if (id === seq.current) setLoading(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [q, near]);

  const ask = () => {
    const text = q.trim();
    if (!text) return;
    Keyboard.dismiss();
    setFocused(false);
    onAsk(text);
  };

  const showList = focused && q.trim().length >= 3;

  return (
    <View style={[styles.wrap, { backgroundColor: t.surface }, shadow(t)]}>
      <View style={styles.row}>
        <Icon name="magnify" color={t.textMuted} />
        <TextInput
          value={q}
          onChangeText={setQ}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 200)}
          onSubmitEditing={() => (results[0] && !NATURAL.test(q) ? onPick(results[0]) : ask())}
          placeholder={'Para onde? Ou peça: "pro trabalho sem pedágio"'}
          placeholderTextColor={t.textMuted}
          returnKeyType="search"
          style={[styles.input, { color: t.text }]}
          accessibilityLabel="Buscar destino"
        />
        {loading || busy ? <ActivityIndicator color={t.primary} /> : null}
        {q ? (
          <Pressable accessibilityLabel="Limpar busca" onPress={() => setQ('')} hitSlop={8}>
            <Icon name="close-circle" color={t.textMuted} size={20} />
          </Pressable>
        ) : null}
      </View>
      {showList ? (
        <View style={[styles.list, { borderTopColor: t.border }]}>
          <Pressable onPress={ask} style={({ pressed }) => [styles.item, pressed && { backgroundColor: t.surfaceAlt }]}>
            <View style={[styles.badge, { backgroundColor: t.learnSoft }]}>
              <Icon name="creation" color={t.learn} size={18} />
            </View>
            <View style={{ flex: 1 }}>
              <T numberOfLines={1}>Pedir ao copiloto</T>
              <T variant="caption" numberOfLines={1}>
                "{q.trim()}"
              </T>
            </View>
          </Pressable>
          {results.slice(0, 6).map((r, i) => (
            <Pressable
              key={`${r.lat},${r.lon},${i}`}
              onPress={() => {
                Keyboard.dismiss();
                setFocused(false);
                setQ(r.name);
                onPick(r);
              }}
              style={({ pressed }) => [styles.item, pressed && { backgroundColor: t.surfaceAlt }]}
            >
              <View style={[styles.badge, { backgroundColor: t.surfaceAlt }]}>
                <Icon name="map-marker-outline" color={t.textMuted} size={18} />
              </View>
              <View style={{ flex: 1 }}>
                <T numberOfLines={1}>{r.name}</T>
                {r.label ? (
                  <T variant="caption" numberOfLines={1}>
                    {r.label}
                  </T>
                ) : null}
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: 20, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, height: 56 },
  input: { flex: 1, fontSize: 16, fontWeight: '500', height: '100%', outlineStyle: 'none' } as never,
  list: { borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  badge: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});
