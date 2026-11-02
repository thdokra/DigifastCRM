/**
 * crm_create_contact — compõe o handler do formulário e não abre conversa.
 *
 * O que se mede: a ferramenta entrega ao `createContactHandler` o corpo já
 * passado pelo schema do país (telefone normalizado, etiqueta em caixa baixa)
 * com a porta `mcp`, devolve a duplicata com o id de quem já existe, e só
 * liga o negócio quando ele ainda não tem contato.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/types";
import type { McpContext } from "@/lib/mcp/types";

const createContact = vi.fn();
const updateLead = vi.fn();

vi.mock("@/app/api/v1/contacts/_handler", () => ({
  createContactHandler: (...a: unknown[]) => createContact(...a),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  updateLeadHandler: (...a: unknown[]) => updateLead(...a),
}));
vi.mock("@/lib/legal/perfil-do-pais", async () => {
  const real = await vi.importActual<Record<string, (...args: never[]) => unknown>>(
    "@/lib/legal/perfil-do-pais",
  );
  return {
    ...real,
    perfilDaOrganizacao: vi.fn(async () => real.perfilDoPais("BR")),
  };
});

const { crmCreateContact } = await import("./create-contact");

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const EXISTENTE = "44444444-4444-4444-8444-444444444444";

function ctx(lead: { id: string; contact_id: string | null } | null): {
  ctx: McpContext;
  filtros: Array<{ coluna: string; valor: unknown }>;
} {
  const filtros: Array<{ coluna: string; valor: unknown }> = [];
  const supabase = {
    from: (tabela: string) => {
      if (tabela !== "crm_leads") throw new Error(`tabela inesperada: ${tabela}`);
      const cadeia = {
        select: () => cadeia,
        eq: (coluna: string, valor: unknown) => {
          filtros.push({ coluna, valor });
          return cadeia;
        },
        maybeSingle: async () => {
          const org = filtros.find((f) => f.coluna === "organization_id")?.valor;
          const id = filtros.find((f) => f.coluna === "id")?.valor;
          const casa = lead && org === ORG && id === lead.id ? lead : null;
          return { data: casa, error: null };
        },
      };
      return cadeia;
    },
  };
  return {
    filtros,
    ctx: {
      organizationId: ORG,
      role: "agent",
      actor: { type: "ai_agent", id: "run-1", role: "agent" },
      apiTokenId: "tok-1",
      requestId: "req-1",
      supabase: supabase as never,
    },
  };
}

const ctxSemBanco = {
  organizationId: ORG,
  role: "agent" as const,
  actor: { type: "ai_agent" as const, id: "run-1", role: "agent" },
  apiTokenId: "tok-1",
  requestId: "req-1",
  supabase: {
    from: () => {
      throw new Error("não deveria consultar o banco");
    },
  },
} as unknown as McpContext;

beforeEach(() => {
  createContact.mockReset();
  updateLead.mockReset();
  createContact.mockImplementation(
    async (
      _sb: unknown,
      _ctx: unknown,
      input: {
        name?: string;
        email?: string | null;
        phone_number?: string | null;
        tags?: string[];
      },
    ) => ({
      action: "created",
      contact: {
        id: CONTATO,
        name: input.name ?? null,
        email: input.email ?? null,
        phone_number: input.phone_number ?? null,
        tags: input.tags ?? [],
      },
    }),
  );
  updateLead.mockResolvedValue({});
});

describe("crm_create_contact", () => {
  it("é escrita de agente", () => {
    expect(crmCreateContact.requiresRole).toBe("agent");
    expect(crmCreateContact.requiresScope).toBe("mcp:write");
    expect(crmCreateContact.category).toBe("write");
  });

  it("grava pela mesma porta do formulário, sem abrir conversa, com telefone e etiqueta normalizados", async () => {
    const saida = await crmCreateContact.handler(
      {
        name: "Ana Lima",
        job_title: "Diretora",
        email: "ana@exemplo.com",
        phone_number: "(11) 98888-7777",
        company: "Oficina Sul",
        tags: ["VIP"],
      },
      ctxSemBanco,
    );

    expect(createContact).toHaveBeenCalledTimes(1);
    const entrada = createContact.mock.calls[0]![2] as Record<string, unknown>;
    const opcoes = createContact.mock.calls[0]![3] as { porta: string };
    expect(opcoes).toEqual({ porta: "mcp" });
    expect(entrada).toMatchObject({
      name: "Ana Lima",
      email: "ana@exemplo.com",
      phone_number: "+5511988887777",
      source: "manual",
      tags: ["vip"],
      custom_fields: { cargo: "Diretora", empresa: "Oficina Sul" },
    });
    expect(updateLead).not.toHaveBeenCalled();
    expect(saida).toMatchObject({
      created: true,
      duplicate: false,
      contact_id: CONTATO,
      phone_number: "+5511988887777",
      job_title: "Diretora",
      company: "Oficina Sul",
      lead_id: null,
    });
  });

  it("telefone inválido não chega ao handler", async () => {
    await expect(
      crmCreateContact.handler({ name: "Ana", phone_number: "abc" }, ctxSemBanco),
    ).rejects.toBeInstanceOf(ApiError);
    expect(createContact).not.toHaveBeenCalled();
  });

  it("duplicata devolve o contato que já existe e não liga o negócio", async () => {
    createContact.mockRejectedValueOnce(
      new ApiError(
        409,
        "contact_exists",
        { contact_id: EXISTENTE },
        "req-1",
        "Já existe um contato com este telefone.",
      ),
    );

    const saida = await crmCreateContact.handler(
      { name: "Ana", phone_number: "+5511988887777", lead_id: LEAD },
      ctx({ id: LEAD, contact_id: null }).ctx,
    );

    expect(saida).toEqual({
      created: false,
      duplicate: true,
      contact_id: EXISTENTE,
      message: "Já existe um contato com este telefone.",
    });
    expect(updateLead).not.toHaveBeenCalled();
  });

  it("liga o contato ao negócio que ainda não tem contato", async () => {
    const banco = ctx({ id: LEAD, contact_id: null });
    const saida = await crmCreateContact.handler({ name: "Ana", lead_id: LEAD }, banco.ctx);

    expect(banco.filtros).toContainEqual({ coluna: "organization_id", valor: ORG });
    expect(updateLead).toHaveBeenCalledTimes(1);
    expect(updateLead.mock.calls[0]![2]).toBe(LEAD);
    expect(updateLead.mock.calls[0]![3]).toEqual({ contact_id: CONTATO });
    expect(saida).toMatchObject({ created: true, contact_id: CONTATO, lead_id: LEAD });
  });

  it("não cria contato quando o negócio já tem outro", async () => {
    await expect(
      crmCreateContact.handler(
        { name: "Ana", lead_id: LEAD },
        ctx({ id: LEAD, contact_id: EXISTENTE }).ctx,
      ),
    ).rejects.toMatchObject({ code: "lead_already_linked" });
    expect(createContact).not.toHaveBeenCalled();
    expect(updateLead).not.toHaveBeenCalled();
  });

  it("negócio de outra organização não existe para esta ferramenta", async () => {
    const banco = ctx({ id: LEAD, contact_id: null });
    banco.ctx.organizationId = "99999999-9999-4999-8999-999999999999";
    await expect(
      crmCreateContact.handler({ name: "Ana", lead_id: LEAD }, banco.ctx),
    ).rejects.toMatchObject({ status: 404 });
    expect(createContact).not.toHaveBeenCalled();
  });

  it("falha ao ligar não esconde o contato que já foi gravado", async () => {
    updateLead.mockRejectedValueOnce(new Error("funil indisponível"));

    const saida = await crmCreateContact.handler(
      { name: "Ana", lead_id: LEAD },
      ctx({ id: LEAD, contact_id: null }).ctx,
    );

    expect(saida).toMatchObject({
      created: true,
      contact_id: CONTATO,
      lead_id: null,
      link_error: "funil indisponível",
    });
  });
});
