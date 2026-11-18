import type { NavFix } from '@trajeto/core';
import * as Location from 'expo-location';
import { create } from 'zustand';

type Permission = 'unknown' | 'granted' | 'denied';

interface LocationState {
  fix: NavFix | null;
  permission: Permission;
  error: string | null;
}

export const useLocationStore = create<LocationState>(() => ({ fix: null, permission: 'unknown', error: null }));

let subscription: Location.LocationSubscription | null = null;

/** Pede permissão e mantém um único watcher de GPS para o app inteiro. */
export async function startLocation(): Promise<void> {
  if (subscription) return;
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') {
      useLocationStore.setState({ permission: 'denied', error: 'Permita o acesso à localização para navegar.' });
      return;
    }
    useLocationStore.setState({ permission: 'granted', error: null });
    subscription = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 2 },
      (p) => {
        useLocationStore.setState({
          fix: {
            t: p.timestamp,
            lat: p.coords.latitude,
            lon: p.coords.longitude,
            speed: p.coords.speed !== null && p.coords.speed >= 0 ? p.coords.speed : null,
            heading: p.coords.heading !== null && p.coords.heading >= 0 ? p.coords.heading : null,
            accuracy: p.coords.accuracy,
          },
        });
      },
    );
  } catch (e) {
    useLocationStore.setState({ error: e instanceof Error ? e.message : 'Localização indisponível' });
  }
}
