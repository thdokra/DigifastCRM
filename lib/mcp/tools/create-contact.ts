/**
 * MCP write tool — crm_create_contact.
 *
 * A LACUNA. `crm_start_conversation_and_send` cria contato só como efeito de
 * abrir conversa e mandar WhatsApp. O `POST /api/v1/contacts` (o "Salvar" da
 * ficha) grava sem mensagem, mas só aceita cookie de sessão — um token `dsk_`
 * não passa por ali.
 *
 * Esta ferramenta chama o MESMO `createContactHandler`: validação do país,
 * telefone normalizado, dedup por telefone/e-mail/CPF (409 `contact_exists`),
 * evento `contact.created` e auditoria. A porta é `mcp`, que não abre
 * conversa (`lib/contacts/conversa-ao-criar.ts`). Cargo e empresa não têm
 * coluna na ficha — vão para `custom_fields` (`cargo`, `empresa`), o mesmo
 * mapa que o formulário já grava e devolve no PATCH.
 */
import { z } from "zod";

import { createContactHandler } from "@/app/api/v1/contacts/_handler";
import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { perfilDaOrganizacao } from "@/lib/legal/perfil-do-pais";
import { contactCreateSchemaDoPais, type ContactCreate } from "@/lib/schemas/contacts";
import type { McpToolDefinition } from "../types";

/** Chaves estáveis no `custom_fields` da ficha. O formulário preserva chave que não desenha. */
const CAMPO_CARGO = "cargo";
const CAMPO_EMPRESA = "empresa";

const inputShape = {
  name: z.string().trim().min(1).max(200).describe("Nome do contato. Obrigatório."),
  job_title: z
    .string()
    .trim()
    .max(120)
    .optional()
    .describe("Cargo. Gravado no campo personalizado `cargo` da ficha."),
  email: z.string().trim().max(320).optional().describe("E-mail. Vazio é o mesmo que omitir."),
  phone_number: z
    .string()
    .trim()
    .max(32)
    .optional()
    .describe(
      "Telefone. Opcional. Passa pela mesma régua do formulário: no Brasil, DDD + número vira E.164; com o país já declarado, o formato internacional também vale.",
    ),
  company: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Empresa. Gravada no campo personalizado `empresa` da ficha."),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional().describe("Etiquetas."),
  lead_id: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Negócio existente ao qual ligar o contato. Só liga se o negócio ainda não tiver contato; não substitui um contato que já esteja lá.",
    ),
};

function texto(valor: string | undefined): string | undefined {
  const limpo = valor?.trim();
  return limpo ? limpo : undefined;
}

export const crmCreateContact: McpToolDefinition<typeof inputShape> = {
  name: "crm_create_contact",
  description:
    "Cria um contato na organização SEM abrir conversa e SEM enviar mensagem. " +
    "Use para cadastrar alguém. Para escrever no WhatsApp, use crm_start_conversation_and_send " +
    "(que também abre a conversa) ou crm_send_whatsapp_message numa conversa que já existe. " +
    "Campos: name (obrigatório), job_title (cargo), email, phone_number (opcional), company (empresa), " +
    "tags e lead_id opcional. Cargo e empresa ficam nos campos personalizados `cargo` e `empresa` da ficha " +
    "(a mesma validação de padrão do formulário; se a organização não desenhou esses campos, o valor fica " +
    "gravado e volta nesta resposta, e o formulário não o apaga ao salvar o resto). " +
    "O telefone é normalizado como no Salvar da ficha. " +
    "Duplicata: se já existir contato com o mesmo telefone, e-mail ou CPF nesta organização, NÃO cria outro " +
    "e NÃO altera o existente — devolve created:false, duplicate:true e o contact_id de quem já está " +
    "cadastrado (o mesmo conflito 409 contact_exists do POST /api/v1/contacts). Nesse caso o lead_id " +
    "não é ligado; use crm_update_lead se quiser ligar a ficha que já existia. " +
    "lead_id só é aceito quando o negócio ainda não tem contato.",
  inputSchema: inputShape,
  category: "write",
  // O mesmo piso de `crm_create_lead` e do POST /api/v1/contacts (`agent`).
  // `manager` tornaria a ferramenta inalcançável pelo agente publicado, que
  // recebe papel `agent` fixo. Cadastrar e anotar não apagam nada.
  requiresRole: "agent",
  requiresScope: "mcp:write",
  redigirParaAuditoria: (args) => {
    const out = { ...args };
    if ("phone_number" in out) out.phone_number = "[redacted]";
    if ("email" in out) out.email = "[redacted]";
    return out;
  },
  handler: async (input, ctx) => {
    const perfil = await perfilDaOrganizacao(ctx.supabase, ctx.organizationId);
    const cargo = texto(input.job_title);
    const empresa = texto(input.company);
    const custom_fields: Record<string, string> = {};
    if (cargo) custom_fields[CAMPO_CARGO] = cargo;
    if (empresa) custom_fields[CAMPO_EMPRESA] = empresa;

    const bruto: Record<string, unknown> = {
      name: input.name.trim(),
      source: "manual",
    };
    const email = texto(input.email);
    const telefone = texto(input.phone_number);
    if (email) bruto.email = email;
    if (telefone) bruto.phone_number = telefone;
    if (input.tags && input.tags.length > 0) bruto.tags = input.tags;
    if (Object.keys(custom_fields).length > 0) bruto.custom_fields = custom_fields;

    const parsed = contactCreateSchemaDoPais(perfil).safeParse(bruto);
    if (!parsed.success) {
      const mensagem = parsed.error.issues[0]?.message ?? "Dados inválidos.";
      throw new ApiError(422, "validation_failed", undefined, ctx.requestId, mensagem);
    }

    if (input.lead_id) {
      const { data: negocio, error } = await ctx.supabase
        .from("crm_leads")
        .select("id, contact_id")
        .eq("organization_id", ctx.organizationId)
        .eq("id", input.lead_id)
        .maybeSingle();
      if (error) throw new ApiError(500, "internal_error", undefined, ctx.requestId, error.message);
      if (!negocio) {
        throw new ApiError(
          404,
          "not_found",
          undefined,
          ctx.requestId,
          "Negócio não encontrado nesta organização.",
        );
      }
      const jaLigado = (negocio as { contact_id?: string | null }).contact_id;
      if (jaLigado) {
        throw new ApiError(
          409,
          "lead_already_linked",
          { lead_id: input.lead_id, contact_id: jaLigado },
          ctx.requestId,
          "Este negócio já está ligado a um contato. Esta ferramenta não substitui esse vínculo; use crm_update_lead se a troca for intencional.",
        );
      }
    }

    let criado;
    try {
      criado = await createContactHandler(
        ctx.supabase,
        {
          organization_id: ctx.organizationId,
          actor: ctx.actor,
          requestId: ctx.requestId,
        },
        parsed.data as ContactCreate,
        { porta: "mcp" },
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.code === "contact_exists") {
        const existente = err.details?.contact_id;
        return {
          created: false,
          duplicate: true,
          contact_id: typeof existente === "string" ? existente : null,
          message: err.message,
        };
      }
      throw err;
    }

    const contact = criado.contact;
    let leadId: string | null = null;
    let linkError: string | null = null;
    if (input.lead_id) {
      try {
        await updateLeadHandler(
          ctx.supabase,
          {
            organization_id: ctx.organizationId,
            actor: ctx.actor,
            requestId: ctx.requestId,
          },
          input.lead_id,
          { contact_id: contact.id },
        );
        leadId = input.lead_id;
      } catch (err) {
        // O contato já está gravado. Esconder o id atrás do erro do vínculo
        // faria o modelo criar de novo e bater na duplicata.
        linkError = err instanceof Error ? err.message : "falha ao ligar o contato ao negócio";
      }
    }

    return {
      created: true,
      duplicate: false,
      contact_id: contact.id,
      name: contact.name,
      email: contact.email,
      phone_number: contact.phone_number,
      tags: contact.tags ?? [],
      job_title: cargo ?? null,
      company: empresa ?? null,
      lead_id: leadId,
      ...(linkError ? { link_error: linkError } : {}),
    };
  },
};
