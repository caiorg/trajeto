/** Web: baixa o JSON como arquivo. O expo-file-system não roda na web e o expo-sharing não compartilha arquivo local nela. */
export async function saveJson(name: string, json: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revogar no mesmo instante pode cancelar o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
