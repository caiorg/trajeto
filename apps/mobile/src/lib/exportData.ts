import { ApiError, api } from './api';
import { saveJson } from './saveJson';

/** Mesmo nome que o servidor manda no `content-disposition` de `GET /me/export`. */
export const EXPORT_FILE_NAME = 'wayboo-dados.json';

export interface ExportResult {
  ok: boolean;
  message: string;
}

/** Busca os dados do usuário e entrega o arquivo: download na web, folha de compartilhamento no celular. */
export async function exportMyData(): Promise<ExportResult> {
  let data: unknown;
  try {
    data = await api.exportMyData();
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? `Não foi possível exportar. ${e.message}` : 'Não foi possível exportar.' };
  }
  try {
    await saveJson(EXPORT_FILE_NAME, JSON.stringify(data, null, 2));
  } catch (e) {
    return { ok: false, message: `Não foi possível gerar o arquivo. ${e instanceof Error ? e.message : ''}`.trim() };
  }
  return { ok: true, message: `Arquivo ${EXPORT_FILE_NAME} gerado.` };
}
