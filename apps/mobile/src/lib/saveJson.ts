import { File, Paths } from 'expo-file-system';
import { isAvailableAsync, shareAsync } from 'expo-sharing';

/**
 * Android e iOS: grava o JSON no cache e abre a folha de compartilhamento do sistema.
 * O nome é fixo, então cada exportação sobrescreve a anterior e fica uma cópia só no aparelho.
 */
export async function saveJson(name: string, json: string): Promise<void> {
  if (!(await isAvailableAsync())) throw new Error('Compartilhamento indisponível neste aparelho.');
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  await file.write(json);
  await shareAsync(file.uri, { mimeType: 'application/json', UTI: 'public.json', dialogTitle: 'Exportar meus dados' });
}
