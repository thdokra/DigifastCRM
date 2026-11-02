/**
 * crm_add_lead_note — a anotação entra na timeline do negócio.
 *
 * A linha usa `buildLeadActivityRow` (a mesma autoria do resto do barramento)
 * e o texto vai em `reason`, que é o que a timeline desenha. Organização vem
 * do token, nunca do argumento.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { McpContext } from "@/lib/mcp/types";

const audit = vi.fn(async (_entrada?: unknown) => undefined);
vi.mock("@/lib/audit", () => ({
  audit: (entrada: unknown) => audit(entrada),
}));

const { crmAddLeadNote } = await import("./lead-note");

const ORG = "11111111-1111-4111-8111-111111111111";
const OUTRA = "99999999-9999-4999-8999-999999999999";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const NOTA = "55555555-5555-4555-8555-555555555555";

interface Estado {
  lead: { id: string; contact_id: string | null; organization_id: string } | null;
  pessoal: boolean;
}

function ctx(estado: Estado): {
  ctx: McpContext;
  inserts: Record<string, unknown>[];
  filtros: Array<{ tabela: string; coluna: string; valor: unknown }>;
} {
  const inserts: Record<string, unknown>[] = [];
  const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
  const supabase = {
    from: (tabela: string) => {
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros.push({ tabela, coluna, valor });
          return cadeia;
        },
        insert: (row: Record<string, unknown>) => {
          inserts.push(row);
          return cadeia;
        },
        maybeSingle: async () => {
          if (tabela === "crm_leads") {
            const org = filtros.find(
              (f) => f.tabela === "crm_leads" && f.coluna === "organization_id",
            )?.valor;
            const id = filtros.find((f) => f.tabela === "crm_leads" && f.coluna === "id")?.valor;
            const casa =
              estado.lead && estado.lead.organization_id === org && estado.lead.id === id
                ? estado.lead
                : null;
            return { data: casa, error: null };
          }
          if (tabela === "contacts") {
            return { data: { is_personal: estado.pessoal }, error: null };
          }
          return { data: null, error: null };
        },
        single: async () => ({ data: { id: NOTA }, error: null }),
      };
      return cadeia;
    },
  };
  return {
    inserts,
    filtros,
    ctx: {
      organizationId: ORG,
      role: "agent",
      actor: { type: "user", id: "user-1" },
      apiTokenId: "tok-1",
      requestId: "req-1",
      supabase: supabase as never,
    },
  };
}

beforeEach(() => {
  audit.mockClear();
});

describe("crm_add_lead_note", () => {
  it("é escrita de agente", () => {
    expect(crmAddLeadNote.requiresRole).toBe("agent");
    expect(crmAddLeadNote.requiresScope).toBe("mcp:write");
  });

  it("grava a anotação na timeline do negócio desta organização e devolve o id", async () => {
    const banco = ctx({
      lead: { id: LEAD, contact_id: CONTATO, organization_id: ORG },
      pessoal: false,
    });

    const saida = await crmAddLeadNote.handler(
      { lead_id: LEAD, note: "Prefere retorno depois das 18h." },
      banco.ctx,
    );

    expect(saida).toEqual({ note_id: NOTA, lead_id: LEAD });
    expect(banco.inserts).toHaveLength(1);
    expect(banco.inserts[0]).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      contact_id: CONTATO,
      type: "note",
      source_module: "crm",
      actor_kind: "user",
      reason: "Prefere retorno depois das 18h.",
      payload: { body: "Prefere retorno depois das 18h." },
    });
    expect(banco.filtros).toContainEqual({
      tabela: "crm_leads",
      coluna: "organization_id",
      valor: ORG,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "lead.note_added", resourceId: NOTA, organizationId: ORG }),
    );
  });

  it("negócio de outra organização não recebe anotação", async () => {
    const banco = ctx({
      lead: { id: LEAD, contact_id: CONTATO, organization_id: OUTRA },
      pessoal: false,
    });

    await expect(
      crmAddLeadNote.handler({ lead_id: LEAD, note: "oi" }, banco.ctx),
    ).rejects.toBeInstanceOf(ApiError);
    expect(banco.inserts).toEqual([]);
    expect(audit).not.toHaveBeenCalled();
  });

  it("contato pessoal não recebe anotação", async () => {
    const banco = ctx({
      lead: { id: LEAD, contact_id: CONTATO, organization_id: ORG },
      pessoal: true,
    });

    const saida = await crmAddLeadNote.handler({ lead_id: LEAD, note: "oi" }, banco.ctx);

    expect(saida).toMatchObject({ permitido: false, motivo: "contato_pessoal" });
    expect(banco.inserts).toEqual([]);
  });
});
