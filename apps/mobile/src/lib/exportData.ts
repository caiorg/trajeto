import { ApiError, api } from './api';
import { saveJson } from './saveJson';

/** Mesmo nome que o servidor manda no `content-disposition` de `GET /me/export`. */
export const EXPORT_FILE_NAME = 'wayboo-dados.json';

export interface ExportResult {
  ok: boolean;
  message: string;
}

function isExport(d: unknown): boolean {
  const tables = (d as { tables?: unknown } | null)?.tables;
  return typeof tables === 'object' && tables !== null && !Array.isArray(tables);
}

/** Busca os dados do usuário e entrega o arquivo: download na web, folha de compartilhamento no celular. */
export async function exportMyData(): Promise<ExportResult> {
  let data: unknown;
  try {
    data = await api.exportMyData();
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? `Não foi possível exportar. ${e.message}` : 'Não foi possível exportar.' };
  }
  // Corpo interrompido ou que não é JSON chega como `{}`: não grava um arquivo vazio nem sobrescreve o anterior.
  if (!isExport(data)) return { ok: false, message: 'Não foi possível exportar. Resposta incompleta do servidor. Tente de novo.' };
  try {
    await saveJson(EXPORT_FILE_NAME, JSON.stringify(data, null, 2));
  } catch (e) {
    return { ok: false, message: `Não foi possível gerar o arquivo. ${e instanceof Error ? e.message : ''}`.trim() };
  }
  return { ok: true, message: `Arquivo ${EXPORT_FILE_NAME} gerado.` };
}
