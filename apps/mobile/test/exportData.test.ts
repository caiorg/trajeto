import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/lib/api';
import { EXPORT_FILE_NAME, exportMyData } from '../src/lib/exportData';
import { saveJson } from '../src/lib/saveJson';
import { saveJson as saveJsonWeb } from '../src/lib/saveJson.web';

vi.mock('../src/lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  api: { exportMyData: vi.fn() },
}));
vi.mock('../src/lib/saveJson', () => ({ saveJson: vi.fn(async () => {}) }));

describe('exportMyData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('grava o JSON indentado com o nome que o servidor usa', async () => {
    const data = { userId: 'u1', exportedAt: '2026-11-20T12:00:00.000Z', tables: { trips: [{ id: 't1' }] } };
    vi.mocked(api.exportMyData).mockResolvedValue(data);
    const r = await exportMyData();
    expect(r).toEqual({ ok: true, message: `Arquivo ${EXPORT_FILE_NAME} gerado.` });
    expect(saveJson).toHaveBeenCalledWith('wayboo-dados.json', JSON.stringify(data, null, 2));
  });

  it('sem conexão, mostra a mensagem da API e não grava nada', async () => {
    vi.mocked(api.exportMyData).mockRejectedValue(new ApiError(0, 'Sem conexão com o servidor (http://x). Confira a URL em Ajustes.'));
    const r = await exportMyData();
    expect(r).toEqual({ ok: false, message: 'Não foi possível exportar. Sem conexão com o servidor (http://x). Confira a URL em Ajustes.' });
    expect(saveJson).not.toHaveBeenCalled();
  });

  it('erro do servidor vira mensagem', async () => {
    vi.mocked(api.exportMyData).mockRejectedValue(new ApiError(500, 'Erro 500'));
    expect(await exportMyData()).toEqual({ ok: false, message: 'Não foi possível exportar. Erro 500' });
  });

  it('resposta sem as tabelas (corpo interrompido) não grava arquivo', async () => {
    vi.mocked(api.exportMyData).mockResolvedValue({} as never);
    expect(await exportMyData()).toEqual({ ok: false, message: 'Não foi possível exportar. Resposta incompleta do servidor. Tente de novo.' });
    expect(saveJson).not.toHaveBeenCalled();
  });

  it('falha ao gravar ou compartilhar vira mensagem', async () => {
    vi.mocked(api.exportMyData).mockResolvedValue({ userId: 'u1', exportedAt: '', tables: {} });
    vi.mocked(saveJson).mockRejectedValueOnce(new Error('Compartilhamento indisponível neste aparelho.'));
    expect(await exportMyData()).toEqual({ ok: false, message: 'Não foi possível gerar o arquivo. Compartilhamento indisponível neste aparelho.' });
  });
});

describe('saveJson na web', () => {
  const anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
  const appendChild = vi.fn();
  const createObjectURL = vi.fn((_: Blob | MediaSource) => 'blob:1');
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { appendChild } });
    vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('baixa um Blob JSON com o nome dado e revoga a URL depois', async () => {
    await saveJsonWeb('wayboo-dados.json', '{"a":1}');
    const blob = createObjectURL.mock.calls[0]![0] as Blob;
    expect(blob.type).toBe('application/json');
    expect(await blob.text()).toBe('{"a":1}');
    expect(anchor).toMatchObject({ href: 'blob:1', download: 'wayboo-dados.json' });
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:1');
  });
});
