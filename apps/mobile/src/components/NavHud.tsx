import { formatDistancePtBR, formatDurationPtBR, maneuverIcon, type ManeuverIcon, type NavState } from '@trajeto/core';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/lib/theme';
import { Card, Chip, Icon, IconButton, T, type IconName } from './ui';

const ICON: Record<ManeuverIcon, IconName> = {
  straight: 'arrow-up',
  right: 'arrow-right-top',
  left: 'arrow-left-top',
  'slight-right': 'arrow-top-right',
  'slight-left': 'arrow-top-left',
  'sharp-right': 'arrow-right-bottom',
  'sharp-left': 'arrow-left-bottom',
  uturn: 'arrow-u-left-top',
  roundabout: 'rotate-left',
  merge: 'call-merge',
  ferry: 'ferry',
  arrive: 'flag-checkered',
};

export function NavBanner({ nav, rerouting, simulated }: { nav: NavState | null; rerouting: boolean; simulated: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const m = nav?.nextManeuver;
  return (
    <View style={[styles.top, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
      <View style={[styles.banner, { backgroundColor: t.dark ? '#0E3A2F' : '#0B6B4F' }]}>
        <Icon name={m ? ICON[maneuverIcon(m.type)] : 'navigation-variant'} color="#FFFFFF" size={44} />
        <View style={{ flex: 1 }}>
          <T variant="display" color="#FFFFFF">
            {nav ? formatDistancePtBR(nav.distanceToManeuverM) : '…'}
          </T>
          <T color="#E6FFF5" numberOfLines={2} style={{ fontSize: 17, fontWeight: '600' }}>
            {m?.instruction ?? 'Aguardando GPS'}
          </T>
        </View>
      </View>
      {nav?.thenManeuver ? (
        <View style={[styles.then, { backgroundColor: t.dark ? '#0A2A22' : '#08533D' }]}>
          <T variant="caption" color="#CFF7E8">
            Depois
          </T>
          <Icon name={ICON[maneuverIcon(nav.thenManeuver.type)]} color="#CFF7E8" size={18} />
        </View>
      ) : null}
      <View style={styles.pills}>
        {rerouting ? <Chip icon="refresh" tone="warning" label="Recalculando rota" /> : null}
        {simulated ? <Chip icon="play-speed" tone="primary" label="Simulação (não aprende)" /> : null}
        {nav?.currentStreet ? <Chip label={nav.currentStreet} /> : null}
      </View>
    </View>
  );
}

export function NavBottomBar({
  nav,
  muted,
  onReport,
  onMute,
  onStop,
}: {
  nav: NavState | null;
  muted: boolean;
  onReport: () => void;
  onMute: () => void;
  onStop: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const pace = nav?.paceRatio ?? 1;
  return (
    <View style={[styles.bottomWrap, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
      <Card style={styles.bottom}>
        <IconButton icon="close" label="Encerrar navegação" onPress={onStop} color={t.danger} />
        <View style={{ flex: 1, alignItems: 'center' }}>
          <T variant="title" color={t.success}>
            {nav ? new Date(nav.arrivalAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '--:--'}
          </T>
          <T variant="caption">
            {nav ? `${formatDurationPtBR(nav.remainingS)} · ${formatDistancePtBR(nav.remainingM)}` : 'calculando'}
          </T>
          {Math.abs(pace - 1) > 0.12 ? (
            <T variant="caption" color={t.learn}>
              {pace > 1 ? 'Mais lento que o previsto' : 'Mais rápido que o previsto'}, ETA ajustado
            </T>
          ) : null}
        </View>
        <IconButton icon={muted ? 'volume-off' : 'volume-high'} label={muted ? 'Ativar voz' : 'Silenciar voz'} onPress={onMute} />
        <IconButton icon="alert-plus" label="Reportar" onPress={onReport} color={t.warning} />
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingHorizontal: 12, gap: 6 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 22 },
  then: { alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14 },
  pills: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  bottomWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
});
